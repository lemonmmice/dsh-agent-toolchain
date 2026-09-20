# 原生栈 unwind（`lib/native-stacks.mjs`）

`DumpStack` 只出**托管**栈。它回答得了"哪个托管方法在等"，回答不了"**原生侧是谁在等、
有没有线程卡在图形驱动里**"。这一页是补上后半截的可复跑步骤 —— 一条命令，不需要装 WinDbg 的 GUI，
也不需要人肉敲 `!wow64exts.sw`。

> 为什么值得固化：同一份卡死 dump，两个不同来源的分析都停在"底层渲染为何未完成，仍需原生线程栈"
> （措辞是"这不代表未解析原生帧已得到验证"）。原因不是分析水平，是**这条路当时不是工具能力**。
> 现在它是了。

## 快速开始

```bash
# 全量：每条线程取 24 帧，原始输出落到文件，终端打印汇总
node lib/native-stacks.mjs <dump> --out <日志文件>

# 只看几条线程（十进制 tid，逗号分隔）
node lib/native-stacks.mjs <dump> --threads 12345,67890 --frames 32

# 离线复跑：不跑 cdb，只解析已有日志（可单测、可复查）
node lib/native-stacks.mjs --from-log <日志文件>

# 机器可读
node lib/native-stacks.mjs <dump> --json

# 快速档：不下载任何符号，只到"模块级"——回答"有没有线程卡在 igc32/d3d9 里"通常足够
node lib/native-stacks.mjs <dump> --no-symbols --out <日志>
```

也可以 `npm run native-stacks -- <dump> --out <日志>`。

## 为什么必须是 **64 位** 调试器

64 位宿主抓 32 位进程（64 位任务管理器、64 位 procdump、64 位 PowerShell 调 `MiniDumpWriteDump`）
得到的是 **x64 格式的 WOW64 dump**：头里 `SystemInfo=AMD64/ptr=8`，但里面跑的是 32 位代码。

- 32 位调试器上，`.effmach x86` / `SetEffectiveProcessorType` 返回 `E_INVALIDARG` —— **改不了**；
- 64 位 `cdb` 加载同一份 dump，`!wow64exts.sw` 一句就能切到 32 位视图，`~*k` 出来的就是 32 位栈。

## 四个坑（模块里已经焊死，测试逐条钉住）

| 坑 | 症状 | 处理 |
| --- | --- | --- |
| **Store 版 WinDbg 的 cdb 不能直接执行** | `拒绝访问`（`…\WindowsApps\…` 下的可执行文件对普通用户不放行） | `resolveCdb()` 自动把 cdb + 引擎 dll + `winext`/`winxp` 拷到可写缓存目录再跑，原包不动 |
| **`!wow64exts.sw` 是切换（toggle）** | 给每条线程都切一次 → 后一半线程又回到 64 位视图，白跑一轮 | 命令串里**只出现一次**，放在最前面；`buildUnwindCommands()` 保证 |
| **WinDbg 数字默认十六进制** | `~~[12345]s` 被当成 `0x12345` → `Illegal thread error` | 按 tid 选线程写成 `~~[0n12345]s` |
| **厂商驱动没有 PDB** | 只能到 `igc32+0x1a2b3`、`nvwgf2umx+0x…` | 这是上限，不是 bug；要函数名只能等厂商符号 |

## cdb 从哪来

按这个顺序找（`resolveCdb()`）：

1. `DSH_NATIVE_CDB` / `DSH_PERF_CDB` / `DSH_HANG_CDB` 指向的 `cdb.exe`；
2. Windows SDK 的 Debugging Tools（`…\Windows Kits\10\Debuggers\x64\cdb.exe`）；
3. **商店版 WinDbg 包**（`winget install Microsoft.WinDbg`，自带 `amd64\cdb.exe`）—— 命中时会自动拷出来；
4. `PATH`。

全都没有时，报错会说明"只有 64 位调试器解得出来"并列出**试过哪些路径**，而不是一句"cdb 缺失"。

## 符号：能拿到什么、拿不到什么

- ✅ 微软的模块（`ntdll` / `KERNELBASE` / `user32` / `wpfgfx_v0400` / `d3d9` / `dxgi` / `dwmapi` …）
  从符号服务器下载，**能到函数名**；
- ⚠ 显卡厂商驱动（`igc32` / `igd9dxva32` / `nvwgf2umx` …）**没有公开 PDB** → 只有 `模块+偏移`；
- ⚠ NGEN 过的托管程序集（`*_ni.dll`）在原生栈上**没有方法名**（只显示 `PresentationCore_ni+0x…`）——
  要看托管方法名请回 `DumpStack` 那份（两者是互补的，不是替代关系）。

符号路径取自 `DSH_NATIVE_SYMBOL_PATH` / `DSH_PERF_SYMBOL_PATH` / `DSH_HANG_SYMBOL_PATH`，
都没有时用"本地缓存 + `https://msdl.microsoft.com/download/symbols`"。**首次跑会下符号** ——
实测在慢网络下，一个只装了 PowerShell/CLR 的小 dump 也能为 `mscorlib.pdb` 这种大文件耗掉十几分钟，
把超时用光（这时结论会带「⚠ 本次运行没有跑完」）。

**所以先跑快速档**：`--no-symbols` 用**一个存在的空目录**覆盖符号路径，完全不碰网络，
模块名来自 dump 自身的模块表，足以回答"有没有线程在 `igc32` / `d3d9` / `dxgi` 里"（这是最常见的问题）。
导出符号（`ntdll!NtWaitForSingleObject` 这一级）是**免费**的，来自 PE 导出表；只有内部函数名
（`wpfgfx_v0400!CMilChannel::WaitForNextMessage`）才需要 pdb。
只有在需要那些内部函数名时才上符号。

⚠ 无符号档解出的**帧数会明显少**（同一份 dump 实测 245 帧 vs 有符号 1109 帧）：
模块级结论不受影响，但**别拿它数帧数、也别据此判断"栈只有这么深"**。

⚠ 坑（实测）：把符号路径传成**空串**并不能关掉下载 —— cdb 会回退到内置默认
`<cdb目录>\sym*https://msdl.microsoft.com/download/symbols`，日志里出现
`DBGHELP: Timeout to store: …msdl…`，一个小 dump 600 秒只出 1 条线程。
必须是**存在的空目录**；换过来之后同一个小 dump **0 秒**出完整线程表。

## 口径（三态，别把"没解析到"读成"没有"）

汇总结论只有三种（外加一个**「没跑完」的自曝状态**），不会含糊：

- **有厂商驱动帧** → 点名哪几条线程、在哪一帧：*这才是"有线程正在驱动里执行"*；
- **解析到帧但没有厂商驱动帧** → 明说"**抓取那一刻**没有线程在驱动里"，并在同一句里写明
  「不等于驱动无问题，也不能反推驱动没卡过」；
- **一帧都没解析到** → 写「**未解析到任何原生栈（未知，不是"没有"）**」并提示去查
  dump 能否被这个 cdb 打开、`!wow64exts.sw` 是否成功、日志里是不是只有线程列表没有 `k` 输出。
- **本次没跑完**（cdb 超时被杀 / 非零退出）→ 结论前面加一句
  「⚠ 本次运行没有跑完（原因）：下面的结论只覆盖日志里已写出的 N 条线程，**不能当全量结论**」。
  ⚠ 实测踩过：**默认符号缓存是空的时候，首次跑能把超时用光，只解出 2/94 条线程** ——
  这一行不加，那半份日志最容易被误读成"整机没有线程在驱动里"。
  想让第二次快起来：把 `DSH_NATIVE_SYMBOL_PATH` / `DSH_PERF_SYMBOL_PATH` 指到一份**已经热过的**
  符号缓存再跑（首次从 `msdl` 下 pdb 可能要十几分钟），或者 `--timeout 0` 表示不设超时。

同时始终给出**有符号帧 / 未解析帧**的计数，方便判断"这一堆 `0x…` 是不是该先修符号"。

## 典型输出

```text
=== 原生栈 unwind ===
dump    : <dumpPath>
cdb     : <cacheDir>\Microsoft.WinDbg_...\amd64\cdb.exe  ← 商店版 WinDbg 包（原位置在 WindowsApps 下不能直接执行，已自动拷到可写目录）
符号    : srv*<cacheDir>*https://msdl.microsoft.com/download/symbols  ← DSH_PERF_SYMBOL_PATH
命令    : .kframes 24; !wow64exts.sw; .echo ===ALL-THREADS===; ~*k; q
退出码  : 0  用时 232.4s
日志    : <日志文件>

解析：94 条线程 / 1099 帧（有符号 1018，未解析 81）
【结论】解析到 94 条线程的原生栈，没有任何一条在执行显卡驱动模块 —— 这只说明**抓取那一刻**
        没有线程在驱动里，不等于驱动无问题，也不能反推"驱动没卡过"。
图形栈上的线程（wpfgfx/d3d/dxgi/…）：2 条
  tid=44576  帧0: ntdll_...!NtWaitForMultipleObjects+0xc   命中@帧3: wpfgfx_v0400!CMilChannel::WaitForNextMessage+0xf0
  tid=33464  帧0: wpfgfx_v0400!CPartitionManager::GetWork+0x159
```

## 与 DumpStack 的分工

| 问题 | 用谁 |
| --- | --- |
| 哪个**托管**方法在等？哪条线程是 UI 线程？ | `DumpStack`（ClrMD，托管栈 + 源码映射） |
| 原生侧是谁在等？有没有线程在**图形驱动**里？ | `lib/native-stacks.mjs`（cdb 原生栈） |
| 卡死那一刻 GPU/驱动在干什么？ | 都不行 —— 要在**复现时**录 ETW（`Microsoft-Windows-DxgKrnl` / D3D9 / DXGI）或 WPR 的 GPU profile |

## 局限（如实）

- 每条线程只取 `--frames` 帧（默认 24）：**更深的帧会被裁掉**，所以"没看到"要按帧数上限打折理解；
- `!wow64exts.sw` 只对 **WOW64 目标**有意义，纯 64 位 dump 用 `--no-wow64-switch`；
- 一次全量 `~*k` 的输出可达数万行，务必 `--out` 落盘再检索（终端只看汇总）；
- 它给的是**一个瞬间**的快照 —— "此刻没有线程在驱动里"推不出"驱动从来没卡过"。
