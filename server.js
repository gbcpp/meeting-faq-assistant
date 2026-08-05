// server.js — Claude Code 后台服务 + SSE 实时推送
// 依赖: npm install express
// 运行: ANTHROPIC_API_KEY=sk-... node server.js  (或已 claude 登录的机器直接 node server.js)
// 环境变量: WORK_DIR(工作目录) PORT SESSION_FILE MODEL
const express = require('express');
const { spawn } = require('child_process');
const fs = require('fs');

const app = express();
app.use(express.json());
app.use(express.static(__dirname)); // 托管 index.html

// ===================== 服务定位：强制走 jrtc-faq skill =====================
const SYSTEM_APPEND = [
  '你是 JRTC 会议问题排查专用助手。',
  '任何用户问题都必须首先加载并使用 jrtc-faq skill，严格遵循该 skill 中定义的排查流程与数据源。',
  '不要使用 skill 之外的方法自行发挥；若问题超出 skill 覆盖范围，明确说明并给出可排查的方向。',
].join('');

// 用户 prompt 再强调一次（双保险）。注意：斜杠命令(/xxx)在 -p 模式下无效，不要用。
const wrapPrompt = (p) => `[使用 jrtc-faq skill]\n${p}`;

const ALLOWED_TOOLS = [
  'mcp__grafana-remote',   // grafana MCP 全部工具
  // 'mcp__clickhouse',    // 如另配了 ClickHouse MCP，取消注释并改成实际 server 名
  'Read',
  'Grep',
  'Glob',
].join(',');

// ===================== 会话表：持久化 + 容量上限 =====================
const SESSION_FILE = process.env.SESSION_FILE || './sessions.json';
const MAX_SESSIONS = 500;

/** key -> { sid: claude的session_id, ts: 最后使用时间 } */
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

  // --- SSE 头 ---
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no', // 反代 nginx 时禁缓冲
  });
  const send = (event, data) =>
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);

  // --- 组装 claude 命令 ---
  const args = [
    '-p', wrapPrompt(prompt),
    '--append-system-prompt', SYSTEM_APPEND,   // 系统级强制 skill，比 user prompt 权重高
    '--output-format', 'stream-json',
    '--verbose',
    '--include-partial-messages',
    '--permission-mode', 'acceptEdits',
    '--allowedTools', ALLOWED_TOOLS,
  ];
  if (process.env.MODEL) args.push('--model', process.env.MODEL);  // 可选：MODEL=claude-sonnet-4-6 降本

  const entry = sessions.get(clientSession);
  if (entry && entry.sid) args.push('--resume', entry.sid);

  const child = spawn('claude', args, {
    cwd: process.env.WORK_DIR || process.cwd(),
    env: process.env,
    stdio: ['ignore', 'pipe', 'pipe'],          // 关闭 stdin：消除 "no stdin data in 3s" 警告
  });

  // --- 逐行解析 NDJSON 并转发 ---
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
        case 'system': // 只处理 init 子类型，其它 system 事件（hook/状态）忽略
          if (msg.subtype === 'init') {
            if (clientSession) {
              sessions.set(clientSession, { sid: msg.session_id, ts: Date.now() });
              persistSessions();
            }
            send('init', { session_id: msg.session_id, model: msg.model });
          }
          break;
        case 'stream_event': { // token 级增量（--include-partial-messages）
          const delta = msg.event?.delta;
          if (delta?.type === 'text_delta') send('delta', { text: delta.text });
          break;
        }
        case 'assistant': { // 完整 assistant 消息（含工具调用）
          for (const block of msg.message?.content || []) {
            if (block.type === 'tool_use')
              send('tool', { name: block.name, input: block.input });
            // 文本已通过 delta 推过，这里只发工具事件，避免重复
          }
          break;
        }
        case 'user': { // 工具执行结果
          for (const block of msg.message?.content || []) {
            if (block.type === 'tool_result') {
              const text = Array.isArray(block.content)
                ? block.content.map((c) => c.text || '').join('')
                : String(block.content ?? '');
              send('tool_result', { text: text.slice(0, 2000) }); // 截断避免撑爆页面
            }
          }
          break;
        }
        case 'result': // 最终结果
          send('done', {
            result: msg.result,
            cost_usd: msg.total_cost_usd,
            duration_ms: msg.duration_ms,
            is_error: msg.is_error,
          });
          break;
      }
    }
  });

  child.stderr.on('data', (d) => send('stderr', { text: d.toString() }));
  child.on('error', (e) => { send('stderr', { text: '启动 claude 失败: ' + e.message }); });
  child.on('close', (code) => { send('exit', { code }); res.end(); });
  req.on('close', () => child.kill('SIGTERM')); // 浏览器断开就杀进程
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, '127.0.0.1', () => {
  console.log(`open http://127.0.0.1:${PORT}`);
  console.log(`work dir : ${process.env.WORK_DIR || process.cwd()}`);
  console.log(`sessions : ${sessions.size} 条已加载 (${SESSION_FILE})`);
});
