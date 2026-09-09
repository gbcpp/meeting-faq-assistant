const express = require('express');
const { Server } = require('@modelcontextprotocol/sdk/server/index.js');
const { StreamableHTTPServerTransport } = require('@modelcontextprotocol/sdk/server/streamableHttp.js');
const { ListToolsRequestSchema, CallToolRequestSchema } = require('@modelcontextprotocol/sdk/types.js');

const ENDPOINT = 'http://victoria-logs.release.beemwk.com/select/logsql/query';
const FIELDS = ['_time', 'action', 'meetingCode', 'roomId', 'userName', 'userId',
  'accountId', 'organizationId', 'appid', 'cloud.profile'];
const FILTERS = ['meetingCode', 'roomId', 'userId', 'userName', 'userNameContains', 'appid'];
const MAX_RANGE_MS = 30 * 24 * 3600 * 1000;
const TOOL = {
  name: 'meeting_lookup',
  description: 'Find meeting/user mappings from configuration records. At least one meeting or user filter is required. Records do not prove attendance. Use SDK/QoS data to verify attendance and quality.',
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  inputSchema: {
    type: 'object', additionalProperties: false,
    properties: {
      meetingCode: { type: 'string', maxLength: 256 },
      roomId: { type: 'string', maxLength: 256 },
      userId: { type: 'string', maxLength: 256 },
      userName: { type: 'string', maxLength: 256, description: 'Exact display name.' },
      userNameContains: { type: 'string', maxLength: 256, description: 'Literal case-insensitive name substring, not a regular expression.' },
      appid: { type: 'string', enum: ['1000', '20002', '30003'] },
      lookbackHours: { type: 'integer', minimum: 1, maximum: 720, default: 24 },
      start: { type: 'string', description: 'ISO timestamp with timezone; supply together with end instead of lookbackHours.' },
      end: { type: 'string', description: 'Exclusive end timestamp with timezone; maximum range is 30 days.' },
      limit: { type: 'integer', minimum: 1, maximum: 200, default: 200 },
    },
  },
};

function buildQuery(args, now = Date.now()) {
  if (!args || typeof args !== 'object' || Array.isArray(args) ||
      Object.keys(args).some(key => !Object.hasOwn(TOOL.inputSchema.properties, key))) {
    throw new Error('Invalid query parameters.');
  }
  for (const key of FILTERS) {
    if (args[key] !== undefined && (typeof args[key] !== 'string' ||
        !args[key].trim() || args[key].length > 256 || /[\x00-\x1f\x7f]/.test(args[key]))) {
      throw new Error('Invalid query filter.');
    }
  }
  if (!FILTERS.slice(0, -1).some(key => args[key]) ||
      (args.appid && !['1000', '20002', '30003'].includes(args.appid))) {
    throw new Error('A meeting or user filter and a valid environment are required.');
  }
  const limit = args.limit ?? 200;
  if (!Number.isInteger(limit) || limit < 1 || limit > 200) throw new Error('Invalid result limit.');
  let start, end;
  if (args.start !== undefined || args.end !== undefined) {
    if (args.lookbackHours !== undefined || [args.start, args.end].some(value =>
      typeof value !== 'string' || !/T.*(?:Z|[+-]\d{2}:\d{2})$/.test(value))) {
      throw new Error('Provide start and end with timezones, without lookbackHours.');
    }
    start = Date.parse(args.start);
    end = Date.parse(args.end);
  } else {
    const hours = args.lookbackHours ?? 24;
    if (!Number.isInteger(hours) || hours < 1 || hours > 720) throw new Error('Invalid lookback range.');
    end = now;
    start = end - hours * 3600 * 1000;
  }
  if (!Number.isFinite(start) || !Number.isFinite(end) || start >= end || end > now || end - start > MAX_RANGE_MS) {
    throw new Error('Invalid time range; maximum is 30 days and future timestamps are not allowed.');
  }
  const range = { start: new Date(start).toISOString(), end: new Date(end).toISOString() };
  const filters = [`_time:[${JSON.stringify(range.start)},${JSON.stringify(range.end)})`,
    'service.name:"beem-jmeeting-sdk-scheduler"'];
  for (const key of FILTERS) {
    if (!args[key]) continue;
    if (key === 'userNameContains') {
      const literal = args[key].replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      filters.push(`userName:~${JSON.stringify('(?i)' + literal)}`);
    } else {
      filters.push(`${key}:=${JSON.stringify(args[key])}`);
    }
  }
  return { query: `${filters.join(' ')} | sort by (_time) desc | fields ${FIELDS.join(', ')}`, limit, range };
}

function createMeetingQuery({ username, password, fetchImpl = fetch, now = Date.now, sanitize = value => value }) {
  return async args => {
    let request;
    try { request = buildQuery(args, now()); }
    catch (error) { return { error: error.message }; }
    if (!username || !password) return { error: 'Query service credentials are not configured.' };
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 65000);
    try {
      const response = await fetchImpl(ENDPOINT, {
        method: 'POST', redirect: 'error', signal: controller.signal,
        headers: { Authorization: `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}` },
        body: new URLSearchParams({ query: request.query, limit: String(request.limit), timeout: '60s' }),
      });
      if (!response.ok) {
        const detail = sanitize((await response.text()) || response.statusText);
        return { error: `Query service request failed (${response.status}): ${detail}` };
      }
      const chunks = [];
      let bytes = 0;
      for await (const chunk of response.body) {
        bytes += chunk.length;
        if (bytes > 2 * 1024 * 1024) {
          controller.abort();
          return { error: 'Query response is too large; narrow the time range.' };
        }
        chunks.push(Buffer.from(chunk));
      }
      const rows = Buffer.concat(chunks).toString('utf8').split('\n').filter(line => line.trim()).map(JSON.parse);
      // Project again locally; never trust the upstream to honor the requested fields.
      const records = rows.slice(0, request.limit).map(row => Object.fromEntries(FIELDS
        .filter(field => typeof row[field] === 'string' && row[field].length <= 1024)
        .map(field => [field, sanitize(row[field], field)])));
      return { records, count: records.length, possiblyTruncated: rows.length >= request.limit,
        range: request.range, evidence: 'Configuration records only; verify attendance with SDK or QoS data.' };
    } catch (error) {
      const detail = sanitize(error instanceof Error ? `${error.name}: ${error.message}` : String(error));
      return { error: controller.signal.aborted ? 'Query service timed out.' : detail };
    } finally {
      clearTimeout(timer);
    }
  };
}

async function startMeetingMcp(query) {
  const app = express();
  // A loopback-only endpoint is for the local CLI, never the browser or a LAN client.
  app.use((req, res, next) => {
    if (req.headers.origin || req.headers.host !== `127.0.0.1:${req.socket.localPort}`) {
      return res.status(403).end();
    }
    next();
  });
  app.use(express.json({ limit: '16kb' }));
  app.post('/mcp', async (req, res) => {
    const server = new Server({ name: 'meeting-query', version: '1.0.0' }, { capabilities: { tools: {} } });
    server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [TOOL] }));
    server.setRequestHandler(CallToolRequestSchema, async request => {
      const result = request.params.name === TOOL.name
        ? await query(request.params.arguments) : { error: 'Unknown query tool.' };
      return { content: [{ type: 'text', text: JSON.stringify(result) }], isError: Boolean(result.error) };
    });
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on('close', () => { void server.close(); });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch {
      if (!res.headersSent) res.status(500).json({ error: 'Query tool unavailable.' });
    }
  });
  app.all('/mcp', (req, res) => res.status(405).end());
  app.use((error, req, res, next) => { res.status(400).json({ error: 'Invalid request.' }); });
  const listener = await new Promise((resolve, reject) => {
    const socket = app.listen(0, '127.0.0.1', error => error ? reject(error) : resolve(socket));
    socket.once('error', reject);
  });
  return { url: `http://127.0.0.1:${listener.address().port}/mcp`,
    close: () => new Promise(resolve => { listener.close(resolve); listener.closeAllConnections(); }) };
}

module.exports = { buildQuery, createMeetingQuery, startMeetingMcp };
