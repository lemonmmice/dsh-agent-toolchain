# dsh-postman（接口调试面板）

DSH Web GUI 插件：一个**类 Postman** 的接口调试面板。

- **HTTP / HTTPS**：选方法 / 填 URL / 加请求头 / 写 body，点发送，看状态码 / 耗时 / 大小 /
  响应头 / 响应体（自动美化 JSON）/ 表格视图（把响应里的对象数组铺成表），并保留请求历史。请求由**宿主进程服务端发起**，因此
  **不受浏览器 CORS 限制**。
- **WebSocket（ws:// / wss://）**：URL 按协议自动切到 WebSocket 客户端 —— 连接 / 断开、
  实时消息日志（收 / 发 / 系统）、发消息、可选子协议。由浏览器直连目标。

## 安装

HTTP 调试入口拒绝调用 UI 运维审批、撤销和急停复位的写操作，并逐跳检查重定向。
这只是工具入口防护；同账号 shell/文件访问仍须独立身份或 broker 才能形成严格授权边界。

> 独立仓库 lemonmmice/dsh-postman 和 lemonmmice/dsh-api-visualizer 已归档，下面的方式 A、B 装到的是并入
> [dsh-agent-toolchain](../../README.md) 之前的旧版本；当前版本按根 README 的 Install (details) 从本仓库部署。

**方式 A：一键脚本**（安装 dsh-postman + dsh-api-visualizer 两个插件并自动注册）：

```powershell
powershell -ExecutionPolicy Bypass -Command "irm https://raw.githubusercontent.com/lemonmmice/dsh-api-visualizer/main/scripts/install.ps1 | iex"
```

**方式 B：命令行**（用 DSH 自带的 pnpm 包装器）：

```sh
dsh plugin --profile web add github:lemonmmice/dsh-postman
```

然后在 profile 的 `cordis.patch.yml`（如 `~/.dsh/profiles/web/cordis.patch.yml`）追加注册块。下面写的是当前版本的包名；方式 B 装到的是归档仓库里的旧版本，包名不同，`name` 要改成它 `package.json` 里的 `name`（也就是 `node_modules` 下实际的目录名）：

```yaml
- insert:
    - id: postman
      name: '@dsh-agent-toolchain/dsh-postman'
```

说明：client.js 的加载要求插件是**可通过 node_modules 解析的包名**（`dsh.client` 声明 +
`exports["./client"]`）。方式 A、B 装到的旧版本用的是旧包名，目录也在旧包名下。从本仓库部署的
当前版本包名是 `@dsh-agent-toolchain/dsh-postman`，注册时用这个名字，并让 `node_modules/@dsh-agent-toolchain/dsh-postman`
能解析到插件：放实体目录，或建一个指向 `plugins/dsh-postman` 的 junction 都可以（Node 会穿透 junction 解析）。

重启 DSH、刷新页面后侧边栏出现「接口调试」入口。

> 方式 B 可能因 pnpm 供应链策略报 `ERR_PNPM_IGNORED_BUILDS`（依赖 protobufjs 带安装
> 脚本）：按提示把打印的键（如 `protobufjs@7.6.5`）加进 profile 的 `pnpm-workspace.yaml`
> 的 `allowBuilds` 后重跑即可；protobufjs 的安装脚本对功能无影响，跳过也不影响使用。

数据都在宿主侧的同一个目录（默认 `~/.dsh/postman`，`$DSH_HOME` 设了就是 `$DSH_HOME/postman`，
可用环境变量 `DSH_POSTMAN_STORE` 覆盖）：

- `history.jsonl`：请求历史（追加写入，上限 2000 条）；
- `workspace.json`：集合、文件夹、请求、环境、全局变量（面板、`http_request`、`http_collection` 共用；
  上一版留在 `workspace.json.bak`）；
- `runs/`：集合运行报告（保留最近 30 份）。

## 结构

```
dsh-postman/
├── package.json        # dsh.bundle.patch + dsh.client(platform: web)
├── cordis.patch.yml    # 注册行 {id: postman, name: '@dsh-agent-toolchain/dsh-postman'}
├── lib/
│   ├── index.js        # 宿主侧：服务端 HTTP 发送 + /api/dsh-postman 路由 + http_request / http_collection 工具 + JSONL 历史 + 提示词通告
│   ├── workspace.mjs   # 集合 / 文件夹 / 环境 / 全局变量的文件存储（workspace.json，跨进程锁 + 原子替换）
│   ├── variables.mjs   # {{变量}} 解析（优先级、嵌套、动态变量）与「模板 → 真正发出的请求」
│   ├── checks.mjs      # 声明式断言与变量提取的求值（JSON 路径、响应头、响应体、状态码、耗时）
│   ├── runner.mjs      # 集合运行器（迭代、数据驱动、失败即停、取消、报告）
│   ├── collection-tool.mjs # http_collection 与 http_request 变量替换的唯一实现（DSH / MCP 两面共用）
│   ├── client.js       # 浏览器侧：侧边栏「接口调试」入口 + HTTP 请求/响应面板 + WebSocket 客户端（纯 DOM）
│   ├── grpc.mjs        # gRPC unary 调用（vendored @grpc/grpc-js + @grpc/proto-loader）
│   └── proxy.mjs       # 宿主连接转发（带鉴权头的 WebSocket / 原始 TCP）
└── README.md
```

## 使用方式

1. **重启 DSH**（插件注册在启动时生效），刷新页面后侧边栏出现「接口调试」入口。
   （改 `lib/client.js` 之后：宿主侧**会**热更新 bundle（实测部署后 `/plugins/events` 的 rev 立刻变），
   浏览器端仍以**刷新页面**为最稳；宿主不重启也不会用到旧代码。）
2. **面板发请求**：选方法、填 URL、在「请求头 / 请求体」里补参数，点「发送」；响应区显示状态码 /
   耗时 / 大小 / 响应头 / 响应体（JSON 自动美化）。URL 输入框回车＝发送。
   响应区第三个 tab「**表格视图**」把响应体里的**对象数组**（`data.list` / `rows` / `items`…）铺成表：
   顺序恒为接口返回顺序（不重排，后端置顶的行标注出来），列 = 行对象的全部字段（按接口字段顺序，
   「顺序」和名称两列冻结在左侧；数字一律按接口原值显示，不换算百分比），
   tab 上带行数角标；不是对象数组（或响应被截断）时**不铺表**，并在那一栏写明原因。
3. **历史**：每次发送自动记录（记的是变量替换后真正发出去的请求），「历史」标签里点任意一条即可回填到编辑器复用。
4. **调 WebSocket / 原始 TCP**（复用同一套消息日志 + 发送框，按钮为「连接 / 断开」）：
   - `ws://` / `wss://`：协议标识变 `WS`。默认**浏览器直连**；勾选「经宿主(带鉴权头)」则由宿主发起握手，
     把「请求头 / 鉴权」里的头带进 WS 握手（浏览器直连设不了握手头）。这些头在 HTTP 模式下设好即可（WS 模式下这些标签隐藏但值仍生效），支持 `{{env}}`。
   - `tcp://host:port`：协议标识变 `TCP`，由**宿主开原始 TCP**（浏览器根本连不了），走 `/conn/*` 转发；二进制帧显示为字节数 + base64。
   - 发消息 Enter / Shift+Enter 换行，消息日志实时收发，`{{env}}` 会替换后再发。
5. **调 gRPC**：URL 填 `grpc://host:port`，协议标识变 `gRPC`。粘贴 `.proto` →「解析 proto」列出服务 / 方法下拉 →
   填请求 message(JSON) → 顶部「调用」发 unary 调用，响应展示在下方；可选 TLS，metadata 取自「请求头 / 鉴权」。
6. **agent 发请求**：用 `http_request` 工具（url 必填，method/headers/body/timeoutMs 可选），
   同样会计入面板历史（仅 HTTP/HTTPS）。URL / 请求头 / 请求体里的 `{{变量}}` 按面板当前选中的环境替换，
   `environment` 参数可指定别的环境（`none` = 不用环境）；结果里的 `variables` 写明用了哪个环境、哪些变量没找到。
7. **agent 管集合、跑回归**：用 `http_collection` 工具——`list` 看有哪些集合 / 请求 / 环境，`get` 读一个请求，
   `save` 存请求（可带断言和提取），`env` 读写环境变量，`run` 跑集合 / 文件夹 / 单个请求并拿回每条断言的结果。
   `outcome=pass` 才表示全部通过；`unchecked` 是一条断言都没有（只说明拿到了响应）。

## 工作流（类 Postman）

- **鉴权助手**：「鉴权」标签选 Bearer Token / Basic Auth，发送时自动生成 `Authorization` 头
  （不写进请求头列表；若已手填 Authorization 则不覆盖）。
- **环境与变量**：标签栏右侧的下拉框选当前环境（或「无环境」），「环境…」管理多套环境（测试 / 预发 / 生产…）和
  全局变量，每行 `KEY=VALUE`，`# KEY=VALUE` 表示停用。发送时 `{{KEY}}` 按
  「只在本次运行有效的提取变量 > 数据行 > 当前环境 > 集合变量 > 全局变量」取值，变量值里还能再引用变量；动态变量 `{{$guid}}` `{{$timestamp}}`
  `{{$timestampMs}}` `{{$isoTimestamp}}` `{{$randomInt}}` 每次取新值。找不到的变量按原样发出，状态栏会提示。
  替换在宿主侧做（与集合运行器、agent 工具同一份实现）；WebSocket / TCP / gRPC 模式下在浏览器里只替换普通变量。
- **cURL 导入**：「导入 cURL」粘贴 curl 命令，解析 method/url/headers/body（含 `-X -H -d/--data*
  -u --url -b -A -e`）回填编辑器。
- **cURL 导出**：「复制 cURL」把当前请求（已套用鉴权与变量替换）复制为 curl 命令。
- **集合与文件夹**：「集合」标签里新建集合 / 文件夹、改名、删除；悬停一行出现「运行 / ＋文件夹 / 变量 / 导出」。
  「保存当前请求」可选集合和文件夹；载入一个已保存的请求后，顶栏「保存」（Ctrl+S）直接覆盖它。
  集合可以导出成 `.dsh-collection.json` 再导入（暂不支持 Postman 自己的集合格式）。
  旧版存在浏览器 `localStorage` 里的集合和环境变量，第一次打开新版时自动搬进宿主（浏览器里的原数据不删）。
- **断言与提取**：「断言」标签给请求加断言（状态码 / JSON 路径 / 响应头 / 响应体 / 耗时，等于、包含、正则、存在、
  类型、属于列表等；期望值可写 `{{变量}}`），和变量提取（从 JSON 路径 / 响应头 / 响应体正则 / 状态码取值，写到当前环境、
  集合变量、全局变量或只在本次运行有效）。发送后响应区「断言结果」逐条显示通过 / 失败和实际值。
  JSON 路径写法：`data.list[0].code`、`$.data.total`、`data["a.b"]`、`list[-1]`、`data.list.length`。
- **集合运行器**：在集合 / 文件夹 / 请求上点「运行」，按顺序发送，可设迭代次数、请求间隔、失败即停、
  是否把提取的变量写回环境，以及数据驱动（CSV 首行表头或 JSON 对象数组，第 i 轮用第 i 行）。
  每个请求一行结果，失败和出错的自动展开（断言实际值、响应体预览）；报告存到 `runs/`。只跑 HTTP(S)。
- **GraphQL**：「请求体」里把类型切到 GraphQL，填 Query + Variables(JSON)；发送时组装成
  `POST {query, variables}`、强制 `application/json`，走同一条 `/send`。「内省查询」按钮一键填入 introspection。

## API（host 侧，loopback-only）

- `GET    /api/dsh-postman/`                    — 探活
- `POST   /api/dsh-postman/send`                — 发请求 `{method,url,headers?,body?,timeoutMs?}`，原样发出，返回 `{id,ts,total,response}`；
  带 `resolve:true` 时是模板模式 `{resolve:true, template, collectionId?, environmentId?, asserts?, extract?, timeoutMs?}`：
  宿主替换变量、发送、求断言和提取（提取结果写回工作区），另返回 `resolved / applied / unresolved / environment / checks`
- `POST   /api/dsh-postman/resolve`             — 只替换变量不发送 `{template, collectionId?, environmentId?}`（复制 cURL 用）
- `GET    /api/dsh-postman/history?limit&q&method` — 历史列表（轻量，无 body）
- `GET    /api/dsh-postman/history/{id}`        — 单条完整记录（请求 + 响应）
- `DELETE /api/dsh-postman/history`             — 清空历史

工作区（改动类接口都返回整份 `{ok, result, workspace, storePath}`）：

- `GET    /workspace` — 整份工作区；`POST /workspace/legacy-import {collections, envText}` — 旧版浏览器数据搬家（只搬一次）
- `POST   /collections {name}`、`PATCH /collections/{id} {name?, variables? | variablesText?}`、`DELETE /collections/{id}`
- `POST   /collections/{id}/items {type:'folder'|'request', parentId?, name, request?, asserts?, extract?}`
- `PATCH  /collections/{id}/items/{itemId} {name?, request?, asserts?, extract?, parentId?}`、`DELETE …/items/{itemId}`
- `GET    /collections/{id}/export`、`POST /collections/import {data}`
- `POST   /environments {name, variables?}`、`PATCH /environments/{id} {name?, variables? | variablesText?}`、`DELETE /environments/{id}`
- `POST   /environments/active {id | null}`、`PUT /globals {variables | variablesText}`

集合运行器：

- `POST   /runs {collectionId, folderId?, requestId?, environmentId?, iterations?, data?, delayMs?, stopOnFailure?, persistVariables?, timeoutMs?}` → `{id, total}`
- `GET    /runs/{id}?since=N` — 进度与第 N 条之后的结果；结束后带 `summary / outcome / notes / reportPath`
- `POST   /runs/{id}/stop`、`GET /runs`

响应结构：`{ ok, status, statusText, durationMs, size, sizeExact, retainedBytes, truncated, contentType, headers, body }`。
响应体流式保留最多 2 MiB，超限即停止读取；此时 `truncated:true`、`sizeExact:false`，
`size` 仅为已收到的字节数下限，总大小未知。未超限时 `sizeExact:true`。
传输失败时 `{ ok:false, error, durationMs }`。非 2xx 属正常结果（`ok:true`）。
程序调用 `sendRequest` 可传 `signal: AbortSignal`，取消返回 `cancelled:true`；`timeoutMs` 覆盖响应头及正文读取。

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
- **未包含的协议**：MQTT 未做；gRPC 只支持 unary。
- **断言与提取不跑脚本**：只有声明式规则（宿主里不执行任意 JS），没有 Postman 的 `pm.*` 脚本。
- **集合运行器只跑 HTTP(S)**：WebSocket / TCP / gRPC 请求在报告里记为跳过；单次运行最多 1000 个请求、100 轮、30 分钟。
- 与 dsh-api-visualizer 面板**互斥**：打开其一会关闭另一，避免叠层。
