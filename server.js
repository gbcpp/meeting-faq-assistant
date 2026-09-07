// Codex CLI backend with real-time SSE forwarding.
// Install: npm install express
// Run: CODEX_API_KEY=sk-... node server.js (or use an existing Codex login)
// Environment: WORK_DIR, PORT, SESSION_FILE, MODEL
const express = require('express');
const { spawn } = require('child_process');
const fs = require('fs');

const app = express();
app.use(express.json());
app.use(express.static(__dirname)); // 托管 index.html

// ===================== 服务定位：强制走 jrtc-faq skill =====================
const SYSTEM_INSTRUCTION = [
  '你是 JRTC 会议问题排查专用助手。',
  '任何用户问题都必须首先加载并使用 jrtc-faq skill，严格遵循该 skill 中定义的排查流程与数据源。',
  '不要使用 skill 之外的方法自行发挥；若问题超出 skill 覆盖范围，明确说明并给出可排查的方向。',
].join('');

// Codex exec has no system-prompt flag, so each turn includes the constraints and explicit skill call.
const wrapPrompt = (p) => `${SYSTEM_INSTRUCTION}\n\n必须先读取并使用 $jrtc-faq skill。\n\n用户问题：\n${p}`;

// ===================== 会话表：持久化 + 容量上限 =====================
const SESSION_FILE = process.env.SESSION_FILE || './sessions.json';
const MAX_SESSIONS = 500;

/** key -> { sid: Codex thread_id, provider: 'codex', ts: last-used time } */
let sessions = new Map();
try {
  if (fs.existsSync(SESSION_FILE)) {
    sessions = new Map(Object.entries(JSON.parse(fs.readFileSync(SESSION_FILE, 'utf8'))));
  }
} catch (e) { console.warn('[warn] 读取 session 文件失败，忽略:', e.message); }

let persistTimer = null;
function persistSessions() {          // 防抖落盘，避免频繁写文件
  clearTimeout(persistTimer);
  persistTimer = setTimeout(() => {
    try {
      // 超出上限时按最后使用时间淘汰最旧的
      if (sessions.size > MAX_SESSIONS) {
        const sorted = [...sessions.entries()].sort((a, b) => (b[1].ts || 0) - (a[1].ts || 0));
        sessions = new Map(sorted.slice(0, MAX_SESSIONS));
      }
      fs.writeFileSync(SESSION_FILE, JSON.stringify(Object.fromEntries(sessions)));
    } catch (e) { console.warn('[warn] 写 session 文件失败:', e.message); }
  }, 500);
}

// ===================== 主路由 =====================
app.get('/api/run', (req, res) => {
  const prompt = req.query.prompt;
  const clientSession = req.query.session || '';
  if (!prompt) return res.status(400).end('missing prompt');
  const startedAt = Date.now();

  // --- SSE 头 ---
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no', // 反代 nginx 时禁缓冲
  });
  const send = (event, data) =>
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);

  // --- Build the Codex command ---
  const args = ['--sandbox', 'read-only', '--ask-for-approval', 'never'];
  if (process.env.MODEL) args.push('--model', process.env.MODEL);
  args.push('exec');
  const entry = sessions.get(clientSession);
  if (entry?.provider === 'codex' && entry.sid) args.push('resume');
  args.push('--json');
  if (entry?.provider === 'codex' && entry.sid) args.push(entry.sid);
  args.push(wrapPrompt(prompt));

  const child = spawn('codex', args, {
    cwd: process.env.WORK_DIR || process.cwd(),
    env: process.env,
    stdio: ['ignore', 'pipe', 'pipe'],          // 关闭 stdin：消除 "no stdin data in 3s" 警告
  });

  // --- Parse and forward JSONL ---
  let buf = '';
  child.stdout.on('data', (chunk) => {
    buf += chunk.toString();
    let idx;
    while ((idx = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, idx).trim();
      buf = buf.slice(idx + 1);
      if (!line) continue;
      let msg;
      try { msg = JSON.parse(line); } catch { continue; }

      switch (msg.type) {
        case 'thread.started':
          if (clientSession) {
            sessions.set(clientSession, { sid: msg.thread_id, provider: 'codex', ts: Date.now() });
            persistSessions();
          }
          send('init', { session_id: msg.thread_id, model: process.env.MODEL || 'default' });
          break;
        case 'turn.started':
          send('thinking', {});
          break;
        case 'item.started': {
          const item = msg.item || {};
          if (item.type === 'reasoning') {
            send('thinking', {});
          } else if (item.type === 'command_execution') {
            send('tool', { name: 'Shell', input: { command: item.command } });
          } else if (item.type === 'mcp_tool_call') {
            send('tool', {
              name: [item.server, item.tool].filter(Boolean).join('/') || 'MCP',
              input: item.arguments || {},
            });
          } else if (item.type === 'web_search') {
            send('tool', { name: 'WebSearch', input: { query: item.query } });
          } else if (item.type === 'file_change') {
            send('tool', { name: 'FileChange', input: { changes: item.changes } });
          }
          break;
        }
        case 'item.completed': {
          const item = msg.item || {};
          if (item.type === 'agent_message') {
            send('delta', { text: item.text || '' });
          } else if (item.type === 'command_execution') {
            send('tool_result', { text: String(item.aggregated_output || '').slice(0, 2000) });
          } else if (item.type === 'mcp_tool_call') {
            const result = item.result ?? item.error ?? '';
            const text = typeof result === 'string' ? result : JSON.stringify(result, null, 2);
            send('tool_result', { text: text.slice(0, 2000) });
          } else if (item.type === 'reasoning') {
            send('thinking', {});
          }
          break;
        }
        case 'turn.completed':
          send('done', {
            duration_ms: Date.now() - startedAt,
            usage: msg.usage || {},
            is_error: false,
          });
          break;
        case 'turn.failed':
          send('stderr', { text: msg.error?.message || msg.error || 'Codex execution failed' });
          send('done', { duration_ms: Date.now() - startedAt, usage: {}, is_error: true });
          break;
        case 'error':
          send('stderr', { text: msg.message || 'Codex CLI error' });
          break;
      }
    }
  });

  child.stderr.on('data', (d) => send('stderr', { text: d.toString() }));
  child.on('error', (e) => { send('stderr', { text: 'Failed to start codex: ' + e.message }); });
  child.on('close', (code) => { send('exit', { code }); res.end(); });
  req.on('close', () => child.kill('SIGTERM')); // 浏览器断开就杀进程
});

const HOST = process.env.HOST || '127.0.0.1';
const PORT = process.env.PORT || 3000;
app.listen(PORT, HOST, () => {
  console.log(`open http://${HOST}:${PORT}`);
  console.log(`work dir : ${process.env.WORK_DIR || process.cwd()}`);
  console.log(`sessions : ${sessions.size} 条已加载 (${SESSION_FILE})`);
});
