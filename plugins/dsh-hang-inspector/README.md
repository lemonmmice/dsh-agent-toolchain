# dsh-hang-inspector（卡死分析面板）

DSH Web GUI 插件：一键卡死诊断工作流 —— 面板「启动监测」按钮拉起主窗口响应监测
（**不自动点击，用户自行操作客户端**），卡死后自动收集证据包，并**自动分析 dump
中的托管线程栈、定位卡死线程、映射到项目源码**，在界面里直接看到出问题的代码。

## 功能

- 工具栏「▶ 启动监测」：一键运行 hang-loop 主窗口响应监测（客户端未运行会自动启动），
  运行横幅实时显示监测日志尾部，可随时「■ 停止监测」；监测只探测窗口响应，不做任何点击；
- 检测到卡死自动收集证据包（冻结截图 / 概要时间线 / 进程信息 / net-trace 尾部 /
  探针与 procdump 日志 / 完整 dump），面板自动选中新包；
- 新包落地后自动分析：DumpStack（ClrMD）解析 `frozen.dmp` 托管线程栈 →
  识别 UI 线程 → 取栈顶项目代码帧 → 在源码树里定位方法并摘出代码段；
- 详情展示「疑似卡死原因」诊断卡片、卡死线程托管栈、全部线程概览、
  「项目代码问题」区块（文件路径 + 行号 + 高亮代码）；分析结果缓存为
  `analysis.json`，可手动「重新分析」；
- 支持删除单个证据包 / 清空全部（本地删除，不可恢复）；面板每 5 秒自动刷新。

## 数据与配置（环境变量可覆盖）

| 用途 | 默认值 | 环境变量 |
| --- | --- | --- |
| 证据目录 | `~/.dsh-agent-toolchain/hang-evidence` | `DSH_HANG_EVIDENCE_DIR` |
| 监测脚本 | `~/.dsh-agent-toolchain/hang-loop.ps1` | `DSH_HANG_LOOP_SCRIPT` |
| 堆栈分析器 | `~/.dsh-agent-toolchain/tools/dumpstack/publish-x86/DumpStack.exe` | `DSH_HANG_DUMPSTACK` |
| DAC 目录 | `~/.dsh-agent-toolchain/tools/dac` | `DSH_HANG_DAC_DIR` |
| 项目源码根 | （必配） | `DSH_HANG_SRC_ROOT` |

## 结构

```
dsh-hang-inspector/
├── package.json        # dsh.bundle.patch + dsh.client(platform: web)
├── cordis.patch.yml    # 注册行 {id: hang-inspector, name: '@dsh-agent-toolchain/dsh-hang-inspector'}
├── lib/
│   ├── index.js        # 宿主侧：/api/dsh-hang-inspector 路由（run / packs / 分析，loopback-only）
│   └── client.js       # 浏览器侧：侧边栏「卡死分析」入口 + 面板（纯 DOM，轮询）
└── README.md
```

## API（host 侧，loopback-only）

- `GET /api/dsh-hang-inspector/` — 探活
- `GET /api/dsh-hang-inspector/run` — 监测运行状态 + 日志尾部
- `POST /api/dsh-hang-inspector/run` — 启动监测（body 可选 `{maxSeconds}`，0 = 一直监测）
- `POST /api/dsh-hang-inspector/run/stop` — 停止监测
- `GET /api/dsh-hang-inspector/packs` — 证据包列表（轻量，无正文）
- `GET /api/dsh-hang-inspector/packs/{id}` — 单个证据包全文证据 + 文件清单 + 分析结果
- `GET /api/dsh-hang-inspector/packs/{id}/screenshot` — 冻结截图 PNG
- `POST /api/dsh-hang-inspector/packs/{id}/analyze` — 启动/重跑堆栈分析
- `GET /api/dsh-hang-inspector/packs/{id}/analysis` — 分析结果（analysis.json）
- `DELETE /api/dsh-hang-inspector/packs/{id}` — 删除单个证据包
- `DELETE /api/dsh-hang-inspector/packs` — 清空全部证据包

## 堆栈分析器（DumpStack）与 DAC 说明

客户端是 **x86 .NET Framework** 进程，dump 也是 32 位：

- DumpStack 必须用 **win-x86** 构建（x64 进程加载不了 32 位 DAC）；
  构建命令：`dotnet publish -c Release -r win-x86 --self-contained true -o publish-x86`
  （项目：`tools/dumpstack/DumpStack.csproj`，ClrMD 包）。
- dump 内 CLR 与本机 DAC 版本不一致时，ClrMD 报 `Could not find matching DAC`，
  需从微软符号服务器下载匹配的 `mscordacwks.dll` 放进 DAC 目录：
  用 `DumpStack.exe dacinfo <dump>` 取 clr.dll 的 `timestamp|size`，然后
  `https://msdl.microsoft.com/download/symbols/mscordacwks.dll/{ts}{size}/mscordacwks.dll`。

## 证据包来源

`hang-loop.ps1`（监测模式：`-IntervalMs` 探测间隔、
`-MaxSeconds` 最长时长、`-NoStart` 不自动启动客户端）检测到客户端卡死时自动生成
（`frozen-screen.png` / `frozen.dmp` / `summary.txt` / `process-info.txt` /
`net-trace-tail.txt` / 探针与 procdump 日志）；面板的分析路由会在包内追加
`dumpstack.json`（原始线程栈）与 `analysis.json`（诊断结果）。
