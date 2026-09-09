# Codex Web

`codex` CLI 的轻量浏览器套壳，专为 **jrtc-faq** （JRTC 会议问题排查）skill 打造。每次请求在后台启动一个 `codex exec` 子进程，通过 SSE 推送状态与经过检查的回复。无构建步骤，使用 Express 和官方 MCP SDK。

## 特性

- **内部查询指导** ：每轮由服务端读取仓库的 `SKILL.md` 并注入查询流程，不依赖旧会话或其他目录中的副本。
- **受限会议查询** ：服务端持有日志凭据，内置 MCP 工具只接收会议、用户和时间条件，不接受任意 URL 或查询语句。
- **完整事件输出** ：网页实时显示思考耗时、Skill/MCP 名称、工具参数、查询语句、工具结果及 stderr；仅密码、Token 等认证值替换为 `[REDACTED]`。
- **多会话续接** ：每个浏览器标签页独立上下文，刷新不丢，通过 `codex exec resume` 续接历史对话。
- **Markdown 渲染** ：marked + DOMPurify，支持代码块、表格、列表等。
- **亮/暗主题** ：右上角按钮切换，默认暗色，选择记忆在 `localStorage`。

## 快速开始

```bash
npm install          # 安装依赖
node server.js       # 启动，监听 http://127.0.0.1:3000
# 或
npm start            # 等价于 node server.js
```

打开浏览器访问 `http://127.0.0.1:3000`，在输入框描述会议问题即可，例如：

> Jack Chen 最近的会议质量怎么样？

- **Enter** 发送 · **Shift+Enter** 换行 · **＋** 新建会话（清空上下文） · 右上角 **☀/☾** 切换主题

### 前置条件

- Node.js 22 或更高版本；本机已安装支持 Streamable HTTP MCP 的 `codex` CLI。
- Grafana MCP 已配置且可用；内部会议查询工具随服务启动自动接入，无需手动注册。
- 服务进程能够连接日志服务；配置 `VICTORIALOGS_PASSWORD` 后才能查询会议与人员映射。
- 已通过 `codex login` 登录，或仅为该服务进程设置 `CODEX_API_KEY`。

## 环境变量

配置项如下；日志查询密码为会议与人员查询所必需：

| 变量 | 说明 | 默认值 |
| --- | --- | --- |
| `WORK_DIR` | `codex` 子进程的工作目录；内部指导始终读取服务仓库中的 `SKILL.md` | 服务进程 cwd |
| `HOST` | HTTP Listen IP | '127.0.0.1'|
| `PORT` | HTTP Listen PORT | `3000` |
| `SESSION_FILE` | 会话映射持久化路径 | `./sessions.json` |
| `MODEL` | 传给 `codex --model`；留空时使用 Codex 配置的默认模型 | 不指定 |
| `CODEX_API_KEY` | 未通过 `codex login` 登录时可用；只应暴露给服务进程 | — |
| `VICTORIALOGS_PASSWORD` | 日志查询密码，仅由服务端持有，不传入 agent 子进程 | — |
| `VICTORIALOGS_USERNAME` | 可选的日志认证账号，仅由服务端持有 | 内置查询账号 |

不再需要 `VICTORIALOGS_NETRC_FILE`。原先启动时传入密码的方式仍可使用，但建议通过服务管理器或下方隐藏输入方式提供，避免进入 shell 历史。

示例：

```bash
WORK_DIR=/path/to/skill-workspace MODEL=gpt-5.3-codex HOST=0.0.0.0 PORT=3000 node server.js
```

## 架构

网页与进程管理在 `server.js`，受限查询在 `meeting-query.js`，单一请求流程如下：

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
3. 内置 MCP 仅监听随机本机回环端口，由 Codex 的 MCP 客户端访问，不需要放开 agent shell 的网络权限；查询目标固定为日志服务，最多查询 30 天、200 条记录。
4. 只将字段白名单数据交给 agent。网页接收原始工具事件、整轮回复和错误详情，发送前仅替换密码、Token 等认证值。

### 两个核心设计

**查询接入。** 服务端每轮注入最新查询指导，通过本次进程配置接入 `meeting_lookup` MCP 工具。Codex 保持 `read-only` 沙箱和 `never` 审批；会议查询密码、Token 和 netrc 路径不传入 agent，查询用户名及其他普通环境变量可以正常使用。

**会话续接。** 浏览器在 `sessionStorage` 生成稳定的 per-tab id（`tab-<uuid>`）作为 `session` 传入。服务端把该 id 映射到 Codex 的 `thread_id`（从 `thread.started` 事件捕获），存于 `sessions` Map，同一标签页下次请求时使用 `codex exec resume <thread-id>`。该映射防抖 500ms 落盘到 `SESSION_FILE`，上限 `MAX_SESSIONS=500`，按最后使用时间（LRU）淘汰。迁移前的 Claude 会话条目会因缺少 `provider: "codex"` 标记而被自动忽略。

### 生命周期

SSE 响应关闭时向子进程发送 `SIGTERM`。工具名、参数、结果和 stderr 直接发送给浏览器；服务端在 SSE 输出及会议 MCP 返回前，将密码、Token 等认证值替换为 `[REDACTED]`。回复在完成后统一处理，避免认证值跨消息分段泄露。

### 可见性与认证值边界

- 升级前的旧会话不会继续恢复，首次请求自动创建新上下文；不删除旧历史文件。网页已经显示过的历史内容需要刷新或新建会话清除。
- HTTP 仅公开 `/` 和 `/index.html`，不把仓库文件直接作为静态资源提供。
- Skill 名称、路径、查询流程、MCP 工具名称、参数、查询语句、业务结果和错误详情允许显示。
- 已知密码、Token 及常见编码会被替换，但文本过滤不是对任意编码或改写的绝对保证。
- 当前服务没有用户登录或会议级授权，只应部署在可信网络或受认证的反向代理之后；本机 MCP 也应只运行在受信任主机上。
- 只读不等于不能读取主机其他文件。生产环境应使用隔离账号或容器限制 agent 可读范围，不在其可读文件中保存凭据。其他已配置 MCP 的权限须由管理员单独限制。
- 日志上游当前使用 HTTP，链路不加密；生产部署应使用可信网络或经验证的 HTTPS/加密代理。

## 文件结构

| 文件 | 作用 |
| --- | --- |
| `server.js` | Express 服务 + SSE 推送 + `codex` 子进程管理 + 会话表 |
| `meeting-query.js` | 本机 MCP 服务、参数校验、服务端认证与字段白名单 |
| `privacy.js` | 密码、Token 等认证值替换及会议凭据环境变量隔离 |
| `query.test.js` | 模拟上游、真实 MCP 协议及 SSE 认证值脱敏测试 |
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

### 内部查询指导

网页查询无需创建符号链接，服务端每轮直接读取本仓库的 `SKILL.md`。维护后新请求即加载最新内容。

### 启动 http server 提供下载服务

```bash
mkdir -p  $PWD/shared
cd $PWD/shared
python3 -m http.server 8081
```

### 启动 Assistant 服务

```bash
npm install

# Bash: read without echoing or saving the password in shell history.
read -r -s -p 'Log service password: ' VICTORIALOGS_PASSWORD
printf '\n'
export VICTORIALOGS_PASSWORD

HOST=10.93.0.26 PORT=8080 VICTORIALOGS_PASSWORD='<password>' node server.js
```

运行 `npm test` 验证参数限制、JSONL 字段筛选、认证值替换、原始工具事件、真实 MCP 调用和静态资源隔离；测试使用模拟凭据，不访问线上日志。
