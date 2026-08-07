# Claude Web

`claude` CLI 的轻量浏览器套壳，专为 **jrtc-faq**（JRTC 会议问题排查）skill 打造。每次请求在后台 `spawn` 一个 `claude` 子进程，把它的输出通过 SSE 实时流式推送到浏览器。无构建步骤，除 Express 外无任何框架。

## 特性

- **强制 skill 路由**：所有查询自动走 `jrtc-faq` skill，用户无需输入任何命令。
- **实时流式输出**：token 级增量渲染，工具调用与结果分块展示。
- **多会话续接**：每个浏览器标签页独立上下文，刷新不丢，可 `--resume` 续接历史对话。
- **Markdown 渲染**：marked + DOMPurify，支持代码块、表格、列表等。

## 快速开始

```bash
npm install          # 安装 express
node server.js       # 启动，监听 http://127.0.0.1:3000
# 或
npm start            # 等价于 node server.js
```

打开浏览器访问 `http://127.0.0.1:3000`，在输入框描述会议问题即可，例如：

> Jack Chen 最近的会议质量怎么样？

- **Enter** 发送 · **Shift+Enter** 换行 · **＋** 新建会话（清空上下文）

### 前置条件

- 本机已安装并可运行 `claude` CLI。
- 运行目录（见 `WORK_DIR`）中 `jrtc-faq` skill 及其 Grafana MCP 可用。
- 已通过 `claude` 登录，或设置 `ANTHROPIC_API_KEY`。

## 环境变量

全部可选：

| 变量 | 说明 | 默认值 |
| --- | --- | --- |
| `WORK_DIR` | `claude` 子进程的工作目录，须为 `jrtc-faq` skill 与 Grafana MCP 可用之处 | 服务进程 cwd |
| `HOST` | HTTP Listen IP | '127.0.0.1'|
| `PORT` | HTTP Listen PORT | `3000` |
| `SESSION_FILE` | 会话映射持久化路径 | `./sessions.json` |
| `MODEL` | 传给 `claude --model`，用于降本，如 `claude-sonnet-4-6` | 不指定 |
| `ANTHROPIC_API_KEY` | 未通过 `claude` 登录时需要 | — |

示例：

```bash
WORK_DIR=/path/to/skill-workspace MODEL=claude-sonnet-4-6 HOST=0.0.0.0 PORT=8080 node server.js
```

## 架构

整个后端逻辑集中在 `server.js`，单一请求流程如下：

```
浏览器 EventSource ──GET /api/run?prompt=&session=──▶ Express
                                                        │
                                            spawn `claude -p ...`
                                                        │
                                          逐行解析 stdout (NDJSON)
                                                        │
                          翻译为具名 SSE 事件 ◀───────────┘
     init · delta · tool · tool_result · stderr · done · exit
                                                        │
浏览器累积 delta 到 markdown 缓冲，marked + DOMPurify 渲染
```

1. 浏览器以 `EventSource` 打开 `GET /api/run?prompt=...&session=<tab-id>`（SSE）。
2. 服务端 `spawn` `claude -p <prompt> --output-format stream-json --include-partial-messages ...`，逐行解析其 NDJSON 标准输出。
3. 每种 `claude` 事件类型被翻译成前端监听的具名 SSE 事件：`init`、`delta`（token 级文本）、`tool`（tool_use）、`tool_result`、`stderr`、`done`、`exit`。
4. 前端（`index.html`，无框架）把 `delta` 文本累积进 markdown 缓冲区并实时渲染；工具调用与结果作为独立块展示。

### 两个核心设计

**强制 skill 路由。** 服务端硬编码要求每个查询都走 `jrtc-faq` skill，两层保障：

- `--append-system-prompt`（`SYSTEM_APPEND`，系统级，权重更高）;
- `wrapPrompt()` 在用户文本前追加前缀（双保险）。

同时 `--allowedTools` 被限制为 `mcp__grafana-remote`、`Read`、`Grep`、`Glob`。注意：斜杠命令（`/xxx`）在 `-p` 模式下无效，不要添加。

**会话续接。** 浏览器在 `sessionStorage` 生成稳定的 per-tab id（`tab-<uuid>`）作为 `session` 传入。服务端把该 id 映射到 `claude` 真实的 `session_id`（从 `init` 事件捕获），存于 `sessions` Map，同一标签页下次请求时带上 `--resume <sid>`。该映射防抖 500ms 落盘到 `SESSION_FILE`，上限 `MAX_SESSIONS=500`，按最后使用时间（LRU）淘汰。UI 上的「＋」按钮会生成新的 tab id 以开启干净上下文。

### 生命周期

`req.on('close')` 向子进程发送 `SIGTERM` —— 关闭浏览器标签页即杀掉底层 `claude` 进程。`tool_result` 文本在服务端截断到 2000 字符，避免撑爆页面。

## 文件结构

| 文件 | 作用 |
| --- | --- |
| `server.js` | Express 服务 + SSE 推送 + `claude` 子进程管理 + 会话表 |
| `index.html` | 单页前端，无框架，负责渲染与交互 |
| `sessions.json` | 会话映射持久化文件（自动生成） |


## 启动

## 启动 mcp server

```bash
export GRAFANA_URL=https://grafana.jaco.live
export GRAFANA_SERVICE_ACCOUNT_TOKEN=glsa_xxxxxxxxxxx

chmod +x mcp-grafana

./mcp-grafana -t streamable-http --address 10.93.0.26:54788 -allowed-hosts 10.93.0.26:54788
```

## claude 添加 mcp server

```bash
claude mcp add --transport http grafana-remote http://10.93.0.26:54788/mcp --scope user
```

## claude 添加 skill

```bash
mkdir -p $HOME/.claude/skills/jrtc-faq
ln -s $PWD/SKILL.md  $HOME/.claude/skills/jrtc-faq/SKILL.md
```

## 启动 http server 提供下载服务

```bash
mkdir -p  $PWD/shared
cd $PWD/shared
python3 -m http.server 8081
```

## 启动 Assistant 服务

```bash
npm instal express

HOST=10.93.0.26 PORT=8080 node server.js
```

