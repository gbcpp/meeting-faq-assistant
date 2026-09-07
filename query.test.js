const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter, once } = require('node:events');
const { PassThrough } = require('node:stream');
const http = require('node:http');
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { StreamableHTTPClientTransport } = require('@modelcontextprotocol/sdk/client/streamableHttp.js');
const { buildQuery, createMeetingQuery, startMeetingMcp } = require('./meeting-query');
const { createPrivacyFilter, agentEnvironment } = require('./privacy');
const { app, start } = require('./server');

const NOW = Date.parse('2026-09-07T12:00:00Z');
const username = 'test-service-account';
const password = 'test-secret-928374';
const privacy = createPrivacyFilter([username, password, `${username}:${password}`]);
const options = { username, password, now: () => NOW, isSensitive: privacy.isSensitive };

test('query builder bounds time and escapes literal filters', () => {
  const request = buildQuery({ meetingCode: '0928420022', userNameContains: 'Eddie.*" | limit 999', limit: 10 }, NOW);
  assert.equal(request.range.start, '2026-09-06T12:00:00.000Z');
  assert.equal(request.range.end, '2026-09-07T12:00:00.000Z');
  assert.match(request.query, /meetingCode:="0928420022"/);
  assert.ok(request.query.includes(`userName:~${JSON.stringify('(?i)Eddie\\.\\*" \\| limit 999')}`));
  assert.ok(request.query.endsWith('organizationId, appid, cloud.profile'));
  assert.equal(request.limit, 10);
  assert.equal(buildQuery({ roomId: '2096926360659628034', start: '2026-09-07T19:00:00+08:00', end: '2026-09-07T20:00:00+08:00' }, NOW).range.start,
    '2026-09-07T11:00:00.000Z');
});

test('reject raw queries, broad scans, invalid filters and unbounded time ranges', () => {
  for (const input of [null, [], {}, { appid: '30003' }, { userId: 123 }, { userId: '' },
    { userId: 'x', query: '*' }, { userId: 'x', url: 'http://other-host' },
    { userId: 'x', limit: 201 }, { userId: 'x', lookbackHours: 721 },
    { userId: 'x', appid: '99999' }, { userName: 'a\nb' },
    { userId: 'x', start: '2026-09-07T00:00:00Z' },
    { userId: 'x', start: '2026-09-07T00:00:00', end: '2026-09-07T01:00:00' },
    { userId: 'x', start: '2026-09-07T00:00:00Z', end: '2026-09-08T00:00:00Z' },
    { userId: 'x', start: '2026-01-01T00:00:00Z', end: '2026-09-07T00:00:00Z' },
    { userId: 'x', lookbackHours: 24, start: '2026-09-07T00:00:00Z', end: '2026-09-07T01:00:00Z' }]) {
    assert.throws(() => buildQuery(input, NOW));
  }
});

test('backend authenticates, preserves string IDs and projects upstream JSONL twice', async () => {
  const query = createMeetingQuery({ ...options, fetchImpl: async (url, request) => {
    assert.equal(url, 'http://victoria-logs.release.beemwk.com/select/logsql/query');
    assert.equal(request.headers.Authorization, `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`);
    assert.equal(request.redirect, 'error');
    assert.equal(request.body.get('timeout'), '60s');
    assert.equal(request.body.get('limit'), '2');
    assert.match(request.body.get('query'), /sort by \(_time\) desc \| fields/);
    return new Response([
      JSON.stringify({ userName: 'Eddie', userId: 'abc', meetingCode: '0928420022', roomId: '2096926360659628034',
        resp: 'Token: upstream-secret', password, Authorization: 'secret', arbitrary: 'drop-me' }),
      JSON.stringify({ userName: password, userId: 'def', configReqHeader: 'Token: hidden' }),
    ].join('\n'));
  } });
  const result = await query({ userNameContains: 'Eddie', limit: 2 });
  assert.equal(result.count, 2);
  assert.equal(result.possiblyTruncated, true);
  assert.equal(result.records[0].roomId, '2096926360659628034');
  assert.equal(result.records[0].meetingCode, '0928420022');
  assert.equal(result.records[1].userName, '[REDACTED]');
  assert.equal(result.records[0].resp, undefined);
  assert.equal(result.records[0].arbitrary, undefined);
  assert.ok(!JSON.stringify(result).includes(password));
  assert.ok(!JSON.stringify(result).includes('upstream-secret'));
});

test('empty success is distinct from sanitized auth, network and parsing failures', async () => {
  const empty = await createMeetingQuery({ ...options, fetchImpl: async () => new Response('') })({ userId: 'abc' });
  assert.deepEqual(empty.records, []);
  assert.equal(empty.possiblyTruncated, false);
  assert.equal(empty.error, undefined);
  for (const fetchImpl of [
    async () => new Response(password, { status: 401 }),
    async () => new Response(password, { status: 403 }),
    async () => new Response(password, { status: 500 }),
    async () => new Response(password),
    async () => { throw new Error(password); },
    async () => new Response('x'.repeat(2 * 1024 * 1024 + 1)),
  ]) {
    const result = await createMeetingQuery({ ...options, fetchImpl })({ userId: 'abc' });
    assert.ok(result.error);
    assert.equal(result.records, undefined);
    assert.ok(!JSON.stringify(result).includes(password));
  }
  let called = false;
  const missing = createMeetingQuery({ username, password: '', fetchImpl: async () => { called = true; } });
  assert.ok((await missing({ userId: 'abc' })).error);
  assert.ok((await missing({ query: '*' })).error);
  assert.equal(called, false);
});

test('agent environment strips all log credentials; output guard covers known encodings', () => {
  assert.deepEqual(agentEnvironment({ PATH: '/bin', CODEX_API_KEY: 'model-key', VICTORIALOGS_PASSWORD: password,
    VICTORIALOGS_TOKEN: 'other', VICTORIALOGS_USERNAME: username, VICTORIALOGS_NETRC_FILE: '/secret' }),
  { PATH: '/bin', CODEX_API_KEY: 'model-key' });
  for (const secret of [password, username, Buffer.from(`${username}:${password}`).toString('base64'),
    password.split('').join(' '), 'jrtc-faq', 'SKILL.md', 'jrtc-\nfaq', 'Authorization: Basic abc', 'token=unknown-secret']) {
    assert.notEqual(privacy.filter(secret), secret);
  }
  assert.equal(privacy.filter('Eddie，userId=abc，会议 0928420022，RTT 21 ms。'), 'Eddie，userId=abc，会议 0928420022，RTT 21 ms。');
});

test('real MCP client can initialize, list and call the loopback query tool', async t => {
  const query = createMeetingQuery({ ...options, fetchImpl: async () => new Response('{"userName":"Eddie","userId":"abc","token":"hidden"}\n') });
  const mcp = await startMeetingMcp(query);
  t.after(() => mcp.close());
  const client = new Client({ name: 'query-test', version: '1.0.0' });
  t.after(() => client.close());
  await client.connect(new StreamableHTTPClientTransport(new URL(mcp.url)));
  const list = await client.listTools();
  assert.equal(list.tools.length, 1);
  assert.equal(list.tools[0].name, 'meeting_lookup');
  const result = await client.callTool({ name: 'meeting_lookup', arguments: { userNameContains: 'Eddie' } });
  assert.equal(result.isError, false);
  assert.deepEqual(JSON.parse(result.content[0].text).records, [{ userName: 'Eddie', userId: 'abc' }]);
  const invalid = await client.callTool({ name: 'meeting_lookup', arguments: { query: '*' } });
  assert.equal(invalid.isError, true);
  assert.equal((await fetch(mcp.url, { method: 'POST', headers: { Origin: 'http://untrusted.example' } })).status, 403);
  const rejectedHost = await new Promise((resolve, reject) => {
    const request = http.request(mcp.url, { method: 'POST', headers: { Host: 'untrusted.example' } }, response => {
      response.resume();
      resolve(response.statusCode);
    });
    request.on('error', reject);
    request.end();
  });
  assert.equal(rejectedHost, 403);
});

test('web serves only the UI and withholds raw events, internal instructions and split secrets', async t => {
  app.locals.meetingMcpUrl = 'http://127.0.0.1:12345/mcp';
  app.locals.privacy = privacy;
  app.locals.agentEnv = agentEnvironment({ PATH: '/bin', VICTORIALOGS_PASSWORD: password });
  let answer = 'Eddie 最近会议网络正常。';
  app.locals.spawnAgent = (command, args, config) => {
    assert.equal(command, 'codex');
    assert.equal(args[args.indexOf('--sandbox') + 1], 'read-only');
    assert.equal(args[args.indexOf('--ask-for-approval') + 1], 'never');
    assert.ok(args.includes('mcp_servers.meeting_lookup.url="http://127.0.0.1:12345/mcp"'));
    assert.equal(config.env.VICTORIALOGS_PASSWORD, undefined);
    assert.ok(!args.join(' ').includes(password));
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = () => {};
    setImmediate(() => {
      const events = [
        { type: 'item.started', item: { type: 'command_execution', command: password } },
        { type: 'item.completed', item: { type: 'command_execution', aggregated_output: 'unknown-upstream-token' } },
        { type: 'item.completed', item: { type: 'mcp_tool_call', result: { token: password } } },
        { type: 'item.completed', item: { type: 'agent_message', text: answer.slice(0, 5) } },
        { type: 'item.completed', item: { type: 'agent_message', text: answer.slice(5) } },
        { type: 'turn.completed', usage: { input_tokens: 10, output_tokens: 5 } },
      ];
      child.stderr.write(password);
      child.stdout.end(events.map(event => JSON.stringify(event)).join('\n') + '\n');
      child.emit('close', 0);
    });
    return child;
  };
  const listener = app.listen(0, '127.0.0.1');
  await once(listener, 'listening');
  t.after(() => new Promise(resolve => { listener.close(resolve); listener.closeAllConnections(); }));
  const base = `http://127.0.0.1:${listener.address().port}`;
  assert.equal((await fetch(base)).status, 200);
  for (const file of ['SKILL.md', 'README.md', 'server.js', 'package.json', 'sessions.json', 'meeting-query.js', '.env']) {
    const response = await fetch(`${base}/${file}`);
    assert.equal(response.status, 404);
    assert.equal(await response.text(), 'Not found.');
  }
  const valid = await (await fetch(`${base}/api/run?prompt=Eddie`)).text();
  assert.ok(valid.includes(answer));
  assert.ok(!valid.includes('event: tool'));
  assert.ok(!valid.includes('unknown-upstream-token'));
  assert.ok(!valid.includes(password));
  for (const sensitive of [password, '使用 jrtc-faq skill 查询。']) {
    answer = sensitive;
    const output = await (await fetch(`${base}/api/run?prompt=Eddie`)).text();
    assert.ok(!output.includes(sensitive));
    assert.ok(output.includes('已隐藏'));
  }
});

test('service startup wires an internal MCP listener without passing credentials to the agent', async t => {
  const saved = { HOST: process.env.HOST, PORT: process.env.PORT,
    VICTORIALOGS_USERNAME: process.env.VICTORIALOGS_USERNAME, VICTORIALOGS_PASSWORD: process.env.VICTORIALOGS_PASSWORD };
  t.after(() => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
  Object.assign(process.env, { HOST: '127.0.0.1', PORT: '0', VICTORIALOGS_USERNAME: username, VICTORIALOGS_PASSWORD: password });
  const listener = await start();
  t.after(() => new Promise(resolve => { listener.close(resolve); listener.closeAllConnections(); }));
  assert.equal(process.env.VICTORIALOGS_PASSWORD, undefined);
  assert.equal(app.locals.agentEnv.VICTORIALOGS_PASSWORD, undefined);
  assert.equal(app.locals.agentEnv.VICTORIALOGS_USERNAME, undefined);
  assert.match(app.locals.meetingMcpUrl, /^http:\/\/127\.0\.0\.1:\d+\/mcp$/);
  assert.notEqual(Number(new URL(app.locals.meetingMcpUrl).port), listener.address().port);
  const client = new Client({ name: 'startup-test', version: '1.0.0' });
  t.after(() => client.close());
  await client.connect(new StreamableHTTPClientTransport(new URL(app.locals.meetingMcpUrl)));
  assert.equal((await client.listTools()).tools[0].name, 'meeting_lookup');
  assert.equal((await fetch(`http://127.0.0.1:${listener.address().port}/mcp`)).status, 404);
});
