# Codex Web

`codex` CLI 的轻量浏览器套壳，专为 **jrtc-faq** （JRTC 会议问题排查）skill 打造。每次请求在后台 `spawn` 一个 `codex exec` 子进程，把 JSONL 事件通过 SSE 实时推送到浏览器。无构建步骤，除 Express 外无任何框架。

## 特性

- **强制 skill 路由** ：所有查询都显式要求 Codex 加载并使用 `jrtc-faq` skill。
- **实时事件输出** ：回复消息、工具调用与工具结果分块展示。Codex CLI 的 `--json` 模式按完整消息块输出文本，不提供 token 级文本增量。
- **多会话续接** ：每个浏览器标签页独立上下文，刷新不丢，通过 `codex exec resume` 续接历史对话。
- **Markdown 渲染** ：marked + DOMPurify，支持代码块、表格、列表等。
- **亮/暗主题** ：右上角按钮切换，默认暗色，选择记忆在 `localStorage`。

## 快速开始

```bash
npm install          # 安装 express
node server.js       # 启动，监听 http://127.0.0.1:3000
# 或
npm start            # 等价于 node server.js
```

打开浏览器访问 `http://127.0.0.1:3000`，在输入框描述会议问题即可，例如：

> Jack Chen 最近的会议质量怎么样？

- **Enter** 发送 · **Shift+Enter** 换行 · **＋** 新建会话（清空上下文） · 右上角 **☀/☾** 切换主题

### 前置条件

- 本机已安装并可运行 `codex` CLI。
- 运行目录（见 `WORK_DIR`）中 `jrtc-faq` skill 及其 Grafana MCP 可用。
- 已通过 `codex login` 登录，或仅为该服务进程设置 `CODEX_API_KEY`。

## 环境变量

全部可选：

| 变量 | 说明 | 默认值 |
| --- | --- | --- |
| `WORK_DIR` | `codex` 子进程的工作目录，须为 `jrtc-faq` skill 与 Grafana MCP 可用之处 | 服务进程 cwd |
| `HOST` | HTTP Listen IP | '127.0.0.1'|
| `PORT` | HTTP Listen PORT | `3000` |
| `SESSION_FILE` | 会话映射持久化路径 | `./sessions.json` |
| `MODEL` | 传给 `codex --model`；留空时使用 Codex 配置的默认模型 | 不指定 |
| `CODEX_API_KEY` | 未通过 `codex login` 登录时可用；只应暴露给服务进程 | — |

示例：

```bash
WORK_DIR=/path/to/skill-workspace MODEL=gpt-5.3-codex HOST=0.0.0.0 PORT=3000 node server.js
```

## 架构

整个后端逻辑集中在 `server.js`，单一请求流程如下：

```
浏览器 EventSource ──GET /api/run?prompt=&session=──▶ Express
                                                        │
                                          spawn `codex exec --json ...`
                                                        │
                                          逐行解析 stdout (JSONL)
                                                        │
                          翻译为具名 SSE 事件 ◀───────────┘
   init · delta · thinking · tool · tool_result · stderr · done · exit
                                                        │
浏览器累积 delta 到 markdown 缓冲，marked + DOMPurify 渲染
```

1. 浏览器以 `EventSource` 打开 `GET /api/run?prompt=...&session=<tab-id>`（SSE）。
2. 服务端 `spawn` `codex --sandbox read-only --ask-for-approval never exec --json <prompt>`，逐行解析其 JSONL 标准输出。
3. Codex 的 `thread.started`、`turn.*` 和 `item.*` 事件被翻译成前端监听的具名 SSE 事件：`init`、`delta`（完整消息块）、`thinking`、`tool`、`tool_result`、`stderr`、`done`、`exit`。
4. 前端（`index.html`，无框架）把 `delta` 文本累积进 markdown 缓冲区并实时渲染；工具调用与结果作为独立块展示，点击可展开/收起。

### 两个核心设计

**强制 skill 路由。** 服务端通过 `wrapPrompt()` 在每轮用户文本前加入助手职责、使用范围与显式 `$jrtc-faq` 调用。Codex CLI 没有 Claude Code 的 `--append-system-prompt` 和 `--allowedTools` 等价参数，因此进程统一运行在 `read-only` 沙箱中，并使用 `never` 审批策略避免无人值守请求挂起。

**会话续接。** 浏览器在 `sessionStorage` 生成稳定的 per-tab id（`tab-<uuid>`）作为 `session` 传入。服务端把该 id 映射到 Codex 的 `thread_id`（从 `thread.started` 事件捕获），存于 `sessions` Map，同一标签页下次请求时使用 `codex exec resume <thread-id>`。该映射防抖 500ms 落盘到 `SESSION_FILE`，上限 `MAX_SESSIONS=500`，按最后使用时间（LRU）淘汰。迁移前的 Claude 会话条目会因缺少 `provider: "codex"` 标记而被自动忽略。

### 生命周期

`req.on('close')` 向子进程发送 `SIGTERM` —— 关闭浏览器标签页即杀掉底层 `codex` 进程。`tool_result` 文本在服务端截断到 2000 字符，避免撑爆页面。

## 文件结构

| 文件 | 作用 |
| --- | --- |
| `server.js` | Express 服务 + SSE 推送 + `codex` 子进程管理 + 会话表 |
| `index.html` | 单页前端，无框架，负责渲染与交互 |
| `sessions.json` | 会话映射持久化文件（自动生成） |


## 部署（含 MCP 与 skill 配置）

### 启动 mcp server

```bash
export GRAFANA_URL=https://grafana.jaco.live
export GRAFANA_SERVICE_ACCOUNT_TOKEN=glsa_xxxxxxxxxxx

chmod +x mcp-grafana

./mcp-grafana -t streamable-http --address 127.0.0.1:3000 -allowed-hosts 127.0.0.1:3000
```

### Codex 添加 MCP server

```bash
codex mcp add grafana-remote --url http://127.0.0.1:3000/mcp
```

### Codex 添加 skill

```bash
mkdir -p $HOME/.agents/skills/jrtc-faq
ln -s $PWD/SKILL.md $HOME/.agents/skills/jrtc-faq/SKILL.md
```

### 启动 http server 提供下载服务

```bash
mkdir -p  $PWD/shared
cd $PWD/shared
python3 -m http.server 8081
```

### 启动 Assistant 服务

```bash
npm install express

HOST=127.0.0.1 PORT=3000 node server.js
```
