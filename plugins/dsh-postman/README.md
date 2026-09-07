# dsh-postman（接口调试面板）

DSH Web GUI 插件：一个**类 Postman** 的接口调试面板。

- **HTTP / HTTPS**：选方法 / 填 URL / 加请求头 / 写 body，点发送，看状态码 / 耗时 / 大小 /
  响应头 / 响应体（自动美化 JSON），并保留请求历史。请求由**宿主进程服务端发起**，因此
  **不受浏览器 CORS 限制**。
- **WebSocket（ws:// / wss://）**：URL 按协议自动切到 WebSocket 客户端 —— 连接 / 断开、
  实时消息日志（收 / 发 / 系统）、发消息、可选子协议。由浏览器直连目标。

## 安装

**方式 A：一键脚本**（安装 dsh-postman + dsh-api-visualizer 两个插件并自动注册）：

```powershell
powershell -ExecutionPolicy Bypass -Command "irm https://raw.githubusercontent.com/lemonmmice/dsh-api-visualizer/main/scripts/install.ps1 | iex"
```

**方式 B：命令行**（用 DSH 自带的 pnpm 包装器）：

```sh
dsh plugin --profile web add github:lemonmmice/dsh-postman
```

然后在 profile 的 `cordis.patch.yml`（如 `~/.dsh/profiles/web/cordis.patch.yml`）追加注册块：

```yaml
- insert:
    - id: postman
      name: '@dsh-agent-toolchain/dsh-postman'
```

说明：client.js 的加载要求插件是**可通过 node_modules 解析的包名**（`dsh.client` 声明 +
`exports["./client"]`），所以放 `node_modules/@dsh-agent-toolchain/` 而非 `plugins/`，且必须是
**实体目录而非 junction**。

重启 DSH、刷新页面后侧边栏出现「接口调试」入口。

> 方式 B 可能因 pnpm 供应链策略报 `ERR_PNPM_IGNORED_BUILDS`（依赖 protobufjs 带安装
> 脚本）：按提示把打印的键（如 `protobufjs@7.6.5`）加进 profile 的 `pnpm-workspace.yaml`
> 的 `allowBuilds` 后重跑即可；protobufjs 的安装脚本对功能无影响，跳过也不影响使用。

历史数据存本地 JSONL 库（`history.jsonl`，追加写入，上限 2000 条，路径可用环境变量
`DSH_POSTMAN_STORE` 覆盖）。

## 结构

```
dsh-postman/
├── package.json        # dsh.bundle.patch + dsh.client(platform: web)
├── cordis.patch.yml    # 注册行 {id: postman, name: '@dsh-agent-toolchain/dsh-postman'}
├── lib/
│   ├── index.js        # 宿主侧：服务端 HTTP 发送 + /api/dsh-postman 路由 + http_request 工具 + JSONL 历史 + 提示词通告
│   ├── client.js       # 浏览器侧：侧边栏「接口调试」入口 + HTTP 请求/响应面板 + WebSocket 客户端（纯 DOM）
│   ├── grpc.mjs        # gRPC unary 调用（vendored @grpc/grpc-js + @grpc/proto-loader）
│   └── proxy.mjs       # 宿主连接转发（带鉴权头的 WebSocket / 原始 TCP）
└── README.md
```

## 使用方式

1. **重启 DSH**（插件注册与 client.js 加载在启动时生效），刷新页面后侧边栏出现「接口调试」入口。
2. **面板发请求**：选方法、填 URL、在「请求头 / 请求体」里补参数，点「发送」；响应区显示状态码 /
   耗时 / 大小 / 响应头 / 响应体（JSON 自动美化）。URL 输入框回车＝发送。
3. **历史**：每次发送自动记录，「历史」标签里点任意一条即可回填到编辑器复用。
4. **调 WebSocket / 原始 TCP**（复用同一套消息日志 + 发送框，按钮为「连接 / 断开」）：
   - `ws://` / `wss://`：协议标识变 `WS`。默认**浏览器直连**；勾选「经宿主(带鉴权头)」则由宿主发起握手，
     把「请求头 / 鉴权」里的头带进 WS 握手（浏览器直连设不了握手头）。这些头在 HTTP 模式下设好即可（WS 模式下这些标签隐藏但值仍生效），支持 `{{env}}`。
   - `tcp://host:port`：协议标识变 `TCP`，由**宿主开原始 TCP**（浏览器根本连不了），走 `/conn/*` 转发；二进制帧显示为字节数 + base64。
   - 发消息 Enter / Shift+Enter 换行，消息日志实时收发，`{{env}}` 会替换后再发。
5. **调 gRPC**：URL 填 `grpc://host:port`，协议标识变 `gRPC`。粘贴 `.proto` →「解析 proto」列出服务 / 方法下拉 →
   填请求 message(JSON) → 顶部「调用」发 unary 调用，响应展示在下方；可选 TLS，metadata 取自「请求头 / 鉴权」。
6. **agent 发请求**：用 `http_request` 工具（method/url 必填，headers/body/timeoutMs 可选），
   同样会计入面板历史（仅 HTTP/HTTPS）。

## 工作流（类 Postman）

- **鉴权助手**：「鉴权」标签选 Bearer Token / Basic Auth，发送时自动生成 `Authorization` 头
  （不写进请求头列表；若已手填 Authorization 则不覆盖）。
- **环境变量**：工具栏「环境变量」按钮，每行 `KEY=VALUE`（`#` 注释）；发送时把 `{{KEY}}`
  替换到 URL / 请求头 / body / WS 消息。存 `localStorage`（键 `dsh-postman-env`）。
- **cURL 导入**：「导入 cURL」粘贴 curl 命令，解析 method/url/headers/body（含 `-X -H -d/--data*
  -u --url -b -A -e`）回填编辑器。
- **cURL 导出**：「复制 cURL」把当前请求（已套用鉴权与变量替换）复制为 curl 命令。
- **保存请求 + 集合**：「集合」标签「保存当前请求」到命名集合；集合树里点请求名载入编辑器、× 删除。
  存 `localStorage`（键 `dsh-postman-collections`），保存的是原始模板（含 `{{变量}}`），载入后发送时再替换。
- **GraphQL**：「请求体」里把类型切到 GraphQL，填 Query + Variables(JSON)；发送时组装成
  `POST {query, variables}`、强制 `application/json`，走同一条 `/send`。「内省查询」按钮一键填入 introspection。

## API（host 侧，loopback-only）

- `GET    /api/dsh-postman/`                    — 探活
- `POST   /api/dsh-postman/send`                — 发请求 `{method,url,headers?,body?,timeoutMs?}`，返回 `{id,ts,total,response}`
- `GET    /api/dsh-postman/history?limit&q&method` — 历史列表（轻量，无 body）
- `GET    /api/dsh-postman/history/{id}`        — 单条完整记录（请求 + 响应）
- `DELETE /api/dsh-postman/history`             — 清空历史

响应结构：`{ ok, status, statusText, durationMs, size, truncated, contentType, headers, body }`；
传输失败时 `{ ok:false, error, durationMs }`。非 2xx 属正常结果（`ok:true`）。

### 连接转发（宿主 WS/TCP 代理，供带鉴权头的 WebSocket 与原始 TCP 使用）

浏览器 `WebSocket` 不能设握手头、更连不了原始 TCP，所以由宿主开连接、`ws` 包发起握手，
浏览器经这几条路由桥接（host→browser 走游标长轮询，browser→host 走 POST）：

- `POST /api/dsh-postman/conn/open`  — `{kind:'ws'|'tcp', url?|host?+port?, tls?, headers?, subprotocols?}` → `{id, kind}`
- `GET  /api/dsh-postman/conn/poll?id&cursor` — 长轮询该连接的事件（`open/message/close/error`，带单调 `seq`）
- `POST /api/dsh-postman/conn/send`  — `{id, data, encoding?}`（`encoding:'base64'` 发二进制，否则 utf8 文本）
- `POST /api/dsh-postman/conn/close` — `{id}`
- `GET  /api/dsh-postman/conn/status`

上限：并发连接 32、单帧保留 256KB、单次发送 1MB、空闲 5 分钟回收。目标地址任意，控制口仍限本机回环。

### gRPC（vendored `@grpc/grpc-js` + `@grpc/proto-loader`）

- `POST /api/dsh-postman/grpc/methods` — `{proto}` → `{services:[{name, methods:[{name,requestStream,responseStream}]}]}`
- `POST /api/dsh-postman/grpc/call`    — `{proto,target,service,method,request(JSON string),metadata?,tls?,deadlineMs?}` → `{ok,durationMs,response}` 或 `{ok:false,error,code?}`

依赖是纯 JS（用内置 http2，不编译原生），已 vendored 进 `node_modules`；仓库 `package.json` 也声明了，克隆后 `npm install` 即可拉齐。目前支持 **unary（非流式）** 方法。

## 说明与边界

- **HTTP 服务端发送**：请求由 Node 宿主用全局 `fetch` 发起，绕过浏览器 CORS；响应体保留上限 **2MB**（超出截断，`truncated:true`）。超时默认 30s、最大 120s。
- **WebSocket 由浏览器直连**（不经宿主）：
  - 浏览器 `WebSocket` API **不支持自定义握手请求头**，鉴权请用 query 参数（`?token=`）或子协议；需要 header 鉴权的场景本面板暂不支持。
  - 握手会带 `Origin: http://127.0.0.1:3080`，目标服务若校验 Origin 需放行。
  - 消息日志上限 500 条（超出丢最旧）；二进制帧显示为 `[二进制 N 字节]`，以文本收发为主。
- **目标 URL 任意**（本机开发调试工具的应有行为）；仅**控制接口**（/api/dsh-postman/*）限本机回环，外部无法调用。
- **未包含的协议**：gRPC / MQTT / 原始 TCP 需要额外依赖或宿主侧流式代理（浏览器无法直连原始 TCP），本版未做；如需可加宿主侧转发。
- 与 dsh-api-visualizer 面板**互斥**：打开其一会关闭另一，避免叠层。
