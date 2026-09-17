// UiFreezeStacks —— 真·PerfView UI Freeze / thread-time 等待分析提取器。
// 用法：
//   UiFreezeStacks <trace.etl|trace.etl.zip> [/process:substr] [/pid:N] [/tid:N]
//                  [/top:N] [/minMs:N] [/warm:N] [/nosym] [/clientBin:dir] [/json:out.json]
//
// 干什么：把 ETW thread-time 栈按**目标 UI 线程**聚合成「冻结 N 秒，其中 M 秒卡在 X」，
// 并区分「消息泵空闲（等用户输入）」与「真卡顿」。栈的 WOW64 拼接 + 托管方法名 + 内核符号
// 全由 TraceEvent（PerfView 引擎）负责，本程序只做聚合与口径。
//
// 输出：stdout 一段人读摘要（可选再写 JSON）；TraceEvent 的转换/符号日志走 stderr，保持 stdout 干净。

using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Linq;
using System.Text;
using System.Text.RegularExpressions;
using Microsoft.Diagnostics.Symbols;
using Microsoft.Diagnostics.Tracing;
using Microsoft.Diagnostics.Tracing.Etlx;
using Microsoft.Diagnostics.Tracing.Stacks;

internal static class UiFreezeStacks
{
    // 消息泵**空闲等待**特征——只匹配"线程正卡在等下一条消息"的那几个真实等待调用：
    //   Win32: MsgWaitForMultipleObjects(Ex) / GetMessage(W) / PeekMessage / WaitMessage
    //   内核 : NtUserMsgWaitForMultipleObjects / NtUserGetMessage / NtUserWaitMessage / xxxRealSleep
    // ⚠ 关键：**不要**匹配 `Dispatcher`/`DispatcherFrame`/`PushFrame`——真卡顿（HttpGet）的栈也会经过
    //   `Dispatcher.PushFrame`（在近 root 处），若拿它当空闲判据会把真卡顿误判成空闲。空闲的判据必须是
    //   "叶子侧真的卡在消息泵等待调用上"（idle 栈含 MsgWaitForMultipleObjects；freeze 栈叶子是 socket/WaitForSingleObject）。
    static readonly Regex IdleRe = new Regex(
        @"MsgWaitForMultipleObjects|GetMessageW?\b|PeekMessage|\bWaitMessage|NtUserGetMessage|NtUserMsgWait|NtUserWaitMessage|xxxRealSleep|SleepInputIdle",
        RegexOptions.Compiled | RegexOptions.IgnoreCase);

    // GUI 消息泵**模块**特征——即使没符号（裸地址）也在：win32k*（GUI 内核）/ wow64win（WOW64 到 win32k 的桥）。
    // 只有跑消息泵的 **UI 线程** 阻塞栈里才有这些；线程池的 socket 等待走 ws2_32/mswsock/ntdll，不含 win32k。
    // ⇒ 用它**无符号**地认出 UI 线程，且把"卡在消息泵=空闲"和"卡在派发的托管活=真卡顿"分开。
    static readonly Regex GuiPumpRe = new Regex(
        @"win32kfull|win32kbase|win32k\.sys|wow64win", RegexOptions.Compiled | RegexOptions.IgnoreCase);
    // 托管"泵自身"帧（Dispatcher/消息循环）——它在**空闲和卡顿都在**，不算"应用在干活"。
    static readonly Regex PumpManagedRe = new Regex(
        @"System\.Windows\.Threading\.Dispatcher|DispatcherFrame|System\.Windows\.Application\.Run|ComponentDispatcher|System\.Windows\.Forms\.Application\.Run|Dispatcher\.PushFrame",
        RegexOptions.Compiled);

    // 一帧是否"托管的应用代码"（有命名空间点号、非 native 函数、非泵自身、非 PerfView 注解伪帧）。
    // 阻塞样本里只要有它 = 线程卡在**派发下来的实际工作**（如 HttpGet），即真卡顿；否则（只有泵/纯 native）= 空闲。
    static bool IsManagedApp(string f)
    {
        int bang = f.IndexOf('!');
        if (bang <= 0) return false;
        if (f.StartsWith("EventData", StringComparison.Ordinal) || f.StartsWith("EventName", StringComparison.Ordinal)
            || f.StartsWith("NETWORK", StringComparison.Ordinal) || f.StartsWith("DiskFile", StringComparison.Ordinal)
            || f.StartsWith("READIED", StringComparison.Ordinal) || f.StartsWith("Process", StringComparison.Ordinal)
            || f.StartsWith("Thread", StringComparison.Ordinal)) return false;
        string rest = f.Substring(bang + 1);
        if (rest.IndexOf('.') < 0) return false;      // native 函数无命名空间点
        if (rest.StartsWith("0x", StringComparison.Ordinal)) return false; // 未解析地址
        if (rest.IndexOf('?') >= 0) return false;      // 未解析
        if (PumpManagedRe.IsMatch(rest)) return false; // 泵自身，不算应用活
        return true;
    }

    // WPF/WinForms 消息泵的正向特征——用来在没给 /tid 时**自动认 UI 线程**（它同时含空闲 GetMessage 和真卡顿）。
    static readonly Regex UiPumpRe = new Regex(
        @"System\.Windows\.Threading\.Dispatcher|ComponentDispatcher|System\.Windows\.Application\.Run|DispatcherFrame\.PushFrame|System\.Windows\.Forms\.Application|Application\.RunDispatcher",
        RegexOptions.Compiled | RegexOptions.IgnoreCase);

    // 只解**用户态**这几个模块的符号（idle 判定 + socket 命名够用）。**故意不解内核**（ntkrnlmp/win32k
    // 那几个 pdb 大且 msdl 慢，system-wide 抓一堆模块会淹死——smoke 首跑就是卡在 ntkrnlmp.pdb 超时的）。
    // 托管帧（HttpGet/Dispatcher/handler）靠 etl 里的 CLR rundown 自动解，根本不走 msdl。
    static readonly HashSet<string> SymWhitelist = new HashSet<string>(StringComparer.OrdinalIgnoreCase)
    {
        "ntdll", "user32", "win32u", "kernelbase", "kernel32", "ws2_32", "mswsock",
        "wininet", "winhttp", "sechost", "combase", "rpcrt4", "clr", "clrjit", "coreclr",
        "ucrtbase", "msvcrt", "wow64", "wow64win", "wow64cpu",
    };

    // 进程帧格式实测：`Process64 <name> (<pid>) Args: …`（pid **不在**行尾，后面还有 Args）。
    static readonly Regex ProcRe = new Regex(@"^Process\w*\s+(.*?)\s+\((\d+)\)", RegexOptions.Compiled);
    // 线程帧格式实测：`Thread (<tid>) CPU=..ms` 或 `Thread (<tid>)`。
    static readonly Regex TidRe = new Regex(@"^Thread\s*\((\d+)\)", RegexOptions.Compiled);

    sealed class ThreadAgg
    {
        public int Tid;
        public int Pid;
        public string ProcName = "";
        public double TotalMs, CpuMs, BlockedMs, IdleMs, FreezeMs;
        public double PumpMs; // 阻塞在消息泵等待(MsgWaitForMultipleObjects/GetMessage)的时间——UI 线程认定用它（泵得最多的那条）
        public bool UiCandidate;
        // 真卡顿栈聚合：完整调用栈(root->leaf, join ';') -> 毫秒
        public readonly Dictionary<string, double> FreezeStacks = new Dictionary<string, double>();
        // 真卡顿"阻塞点"（叶子=醒来点=阻塞返回处）聚合
        public readonly Dictionary<string, double> FreezeLeaves = new Dictionary<string, double>();
        // 最长的几段单次冻结（近似：这里用"同栈累计"给不出单段，改在 caller 层用样本时长；见 Longest）
        public double LongestSampleMs;
    }

    static int Main(string[] args)
    {
        if (args.Length == 0 || args[0].StartsWith("/"))
        {
            Console.Error.WriteLine("usage: UiFreezeStacks <trace.etl|.etl.zip> [/process:substr] [/pid:N] [/tid:N] [/top:N] [/minMs:N] [/warm:N] [/nosym] [/clientBin:dir] [/json:out.json]");
            return 2;
        }
        try { Console.OutputEncoding = new UTF8Encoding(false); } catch { /* redirected console may reject */ }
        string input = args[0];
        string procSubstr = null, clientBin = null, jsonOut = null;
        int wantPid = -1, wantTid = -1, top = 20, warm = 20;
        double minMs = 1.0;
        bool noSym = false, allSym = false, dbg = false, symCached = false;
        foreach (var a in args.Skip(1))
        {
            if (a.StartsWith("/process:", StringComparison.OrdinalIgnoreCase)) procSubstr = a.Substring(9);
            else if (a.StartsWith("/pid:", StringComparison.OrdinalIgnoreCase)) int.TryParse(a.Substring(5), out wantPid);
            else if (a.StartsWith("/tid:", StringComparison.OrdinalIgnoreCase)) int.TryParse(a.Substring(5), out wantTid);
            else if (a.StartsWith("/top:", StringComparison.OrdinalIgnoreCase)) int.TryParse(a.Substring(5), out top);
            else if (a.StartsWith("/warm:", StringComparison.OrdinalIgnoreCase)) int.TryParse(a.Substring(6), out warm);
            else if (a.StartsWith("/minMs:", StringComparison.OrdinalIgnoreCase)) double.TryParse(a.Substring(7), NumberStyles.Float, CultureInfo.InvariantCulture, out minMs);
            else if (a.Equals("/nosym", StringComparison.OrdinalIgnoreCase)) noSym = true;
            else if (a.Equals("/allsym", StringComparison.OrdinalIgnoreCase)) allSym = true; // 连内核也解（慢，一般不用）
            else if (a.Equals("/symcached", StringComparison.OrdinalIgnoreCase)) symCached = true; // 只用本地符号缓存，绝不连 msdl（快）
            else if (a.Equals("/dbg", StringComparison.OrdinalIgnoreCase)) dbg = true;      // 打印前几条原始栈核对格式
            else if (a.StartsWith("/clientBin:", StringComparison.OrdinalIgnoreCase)) clientBin = a.Substring(11);
            else if (a.StartsWith("/json:", StringComparison.OrdinalIgnoreCase)) jsonOut = a.Substring(6);
        }

        var log = Console.Error;
        if (!File.Exists(input)) { Console.Error.WriteLine("no such file: " + input); return 2; }

        // ① etl.zip → 解出 .etl（同时带出 NGENPDB 等符号到 SymbolDirectory）
        string etl = input;
        string zipSymDir = null;
        if (input.EndsWith(".zip", StringComparison.OrdinalIgnoreCase))
        {
            log.WriteLine("[uifreeze] unpacking " + input);
            var z = new ZippedETLReader(input, log);
            z.UnpackArchive();
            etl = z.EtlFileName;
            zipSymDir = z.SymbolDirectory;
            log.WriteLine("[uifreeze] etl=" + etl + " symDir=" + zipSymDir);
        }

        // ② TraceLog：转 .etlx（WOW64 拼接 + 托管方法映射都在这一步）
        log.WriteLine("[uifreeze] opening/converting TraceLog (WOW64 stitch + managed method map)...");
        var options = new TraceLogOptions() { ConversionLog = log };
        var traceLog = TraceLog.OpenOrConvert(etl, options);
        double sessionMs = traceLog.SessionDuration.TotalMilliseconds;
        log.WriteLine("[uifreeze] session=" + sessionMs.ToString("F0") + "ms, events=" + traceLog.EventCount);

        // ③ 符号：msdl + zip 带出的符号目录 + 可选客户端 bin（托管帧不依赖它）
        SymbolReader symReader = null;
        if (!noSym)
        {
            var symCache = Path.Combine(Path.GetTempPath(), "dsh-symcache");
            var sb = new StringBuilder();
            if (!string.IsNullOrEmpty(zipSymDir)) sb.Append(zipSymDir).Append(';');
            if (!string.IsNullOrEmpty(clientBin)) sb.Append(clientBin).Append(';');
            // /symcached：只挂本地缓存当"服务器"、无上游 URL ⇒ 已缓存的(user32/ntdll/win32u…)秒解，没缓存的直接放弃、**绝不下载**。
            if (symCached) sb.Append("SRV*").Append(symCache);
            else sb.Append("SRV*").Append(symCache).Append("*https://msdl.microsoft.com/download/symbols");
            symReader = new SymbolReader(log, sb.ToString(), null) { SecurityCheck = _ => true };
        }

        // ④ ThreadTimeStackComputer —— PerfView「Thread Time」那张图的引擎
        log.WriteLine("[uifreeze] generating thread-time stacks...");
        var stackSource = new MutableTraceEventStackSource(traceLog);
        var computer = new ThreadTimeStackComputer(traceLog, symReader);
        computer.GenerateThreadTimeStacks(stackSource);

        // ⑤ 解热模块符号（native；托管已解）——只解白名单里的**用户态**模块（除非 /allsym），
        //    出现 >= warm 次才去 msdl。**不解内核**：ntkrnlmp.pdb 大且慢，且 idle 判定用不到（用户态 user32/ntdll 够）。
        if (symReader != null)
        {
            Predicate<TraceModuleFile> shouldLoad = allSym ? (Predicate<TraceModuleFile>)(m => true) : (m =>
            {
                string n = m == null ? null : m.Name;
                if (string.IsNullOrEmpty(n) && m != null && !string.IsNullOrEmpty(m.FilePath))
                    n = Path.GetFileNameWithoutExtension(m.FilePath);
                return !string.IsNullOrEmpty(n) && SymWhitelist.Contains(n);
            });
            log.WriteLine("[uifreeze] resolving warm symbols (minCount=" + warm + ", " + (allSym ? "ALL modules" : "user-mode whitelist") + ") ...");
            try { stackSource.LookupWarmSymbols(warm, symReader, stackSource, shouldLoad); }
            catch (Exception ex) { log.WriteLine("[uifreeze] warm-symbol lookup failed (continuing): " + ex.Message); }
        }

        // (debug) 打印前几条原始栈（含全部伪帧），核对 Process/Thread/READIED/LAST_BLOCK 的真实字符串
        if (dbg)
        {
            int shown = 0;
            stackSource.ForEach(sample =>
            {
                if (shown >= 5) return;
                var di = sample.StackIndex;
                var names = new List<string>();
                while (di != StackSourceCallStackIndex.Invalid)
                {
                    names.Add(stackSource.GetFrameName(stackSource.GetFrameIndex(di), false));
                    di = stackSource.GetCallerIndex(di);
                }
                log.WriteLine("[dbg] #" + shown + " metric=" + sample.Metric.ToString("F1") + "ms frames(leaf->root):");
                foreach (var n in names) log.WriteLine("       | " + n);
                shown++;
            });
        }

        // ⑥ 逐样本聚合。thread-time 的 BLOCKED 样本栈结构（leaf->root）：
        //   BLOCKED_TIME / LAST_BLOCK            ← 状态伪帧（叶子）；LAST_BLOCK=卡到 trace 结束没醒（抓停时仍在卡）
        //   <唤醒者的栈> (READIED_BY) …           ← "谁唤醒我"子栈——**丢掉**（是 waker 的栈，不是"我卡在哪"）
        //   READIED BY TID(x) …                  ← 唤醒标记——丢
        //   ntdll!… → …（真正阻塞时的调用栈）      ← **这才是"我卡在哪"**（要的就是它）
        //   Thread (tid) / Process64 name (pid)  ← 线程/进程伪帧
        var byThread = new Dictionary<int, ThreadAgg>();
        // (census) 每条线程"解析出名字的帧"集合。/nosym 时解析出的只有托管帧（rundown）——正好用来认 UI 线程 + 找 HttpGet。
        var census = dbg ? new Dictionary<int, HashSet<string>>() : null;
        stackSource.ForEach(sample =>
        {
            double ms = sample.Metric;
            if (ms <= 0) return;
            int pid = -1, tid = -1; string procName = null;
            bool isBlocked = false, isCpu = false;
            var real = new List<string>(64); // 真实阻塞栈 leaf->root（已剔状态/waker/线程/进程）
            var idx = sample.StackIndex;
            while (idx != StackSourceCallStackIndex.Invalid)
            {
                string name = stackSource.GetFrameName(stackSource.GetFrameIndex(idx), false);
                idx = stackSource.GetCallerIndex(idx);
                if (string.IsNullOrEmpty(name)) continue;
                if (name.StartsWith("BLOCKED_TIME", StringComparison.Ordinal) || name.StartsWith("LAST_BLOCK", StringComparison.Ordinal)) { isBlocked = true; continue; }
                if (name.StartsWith("CPU_TIME", StringComparison.Ordinal)) { isCpu = true; continue; }
                if (name.StartsWith("READIED_TIME", StringComparison.Ordinal)) continue;         // ready-等CPU，不进阻塞栈
                if (name.IndexOf("(READIED_BY)", StringComparison.Ordinal) >= 0) continue;       // waker 子栈：丢
                if (name.StartsWith("READIED BY", StringComparison.Ordinal)) continue;           // waker 标记：丢
                var mt = TidRe.Match(name);
                if (mt.Success) { if (tid < 0) int.TryParse(mt.Groups[1].Value, out tid); continue; }
                if (name.StartsWith("Process", StringComparison.Ordinal))
                {
                    var mp = ProcRe.Match(name);
                    if (mp.Success) { if (procName == null) procName = mp.Groups[1].Value; if (pid < 0) int.TryParse(mp.Groups[2].Value, out pid); }
                    continue;
                }
                real.Add(name); // 真实阻塞栈帧（leaf->root）
            }
            if (tid < 0) return;
            if (wantPid >= 0 && pid != wantPid) return;

            if (!byThread.TryGetValue(tid, out var agg)) { agg = new ThreadAgg { Tid = tid, Pid = pid }; byThread[tid] = agg; }
            if (pid >= 0 && agg.Pid < 0) agg.Pid = pid;
            if (procName != null && string.IsNullOrEmpty(agg.ProcName)) agg.ProcName = procName;

            agg.TotalMs += ms;
            if (ms > agg.LongestSampleMs) agg.LongestSampleMs = ms;
            if (isCpu) { agg.CpuMs += ms; }
            else if (isBlocked)
            {
                agg.BlockedMs += ms;
                bool hasManagedApp = real.Any(IsManagedApp);
                bool hasGuiPump = real.Any(f => GuiPumpRe.IsMatch(f));
                bool isPumpWait = real.Any(f => IdleRe.IsMatch(f)); // 卡在"等下一条消息"（MsgWait/GetMessage，需 user32/win32u 符号）
                if (isPumpWait) agg.PumpMs += ms;
                if (hasGuiPump || isPumpWait) agg.UiCandidate = true; // 有 GUI 泵 = UI 线程
                // 空闲 = 卡在消息泵、且没有派发下来的应用活（GUI 泵或 MsgWait 命中，但无托管应用帧）。
                bool idle = (hasGuiPump || real.Any(f => IdleRe.IsMatch(f))) && !hasManagedApp;
                if (idle) agg.IdleMs += ms;
                else
                {
                    agg.FreezeMs += ms;
                    if (real.Count > 0)
                    {
                        var rl = new List<string>(real); rl.Reverse(); // root->leaf 便于阅读
                        string stack = string.Join(";", rl);
                        agg.FreezeStacks[stack] = agg.FreezeStacks.TryGetValue(stack, out var v) ? v + ms : ms;
                        string leaf = real[0]; // leaf = 真正阻塞点（醒来/卡住处）
                        agg.FreezeLeaves[leaf] = agg.FreezeLeaves.TryGetValue(leaf, out var lv) ? lv + ms : ms;
                    }
                }
            }
            if (!agg.UiCandidate && real.Any(f => UiPumpRe.IsMatch(f))) agg.UiCandidate = true;

            if (census != null)
            {
                if (!census.TryGetValue(tid, out var set)) { set = new HashSet<string>(); census[tid] = set; }
                foreach (var f in real)
                    if (f.IndexOf("!?", StringComparison.Ordinal) < 0 && f.IndexOf("!0x", StringComparison.Ordinal) < 0)
                        set.Add(f); // 解析出真实名字的帧（/nosym 下≈托管帧）
            }
        });

        // (census) 打印每条线程解析出的帧——认 UI 线程（含 Dispatcher/win32k 泵）+ 找 HttpGet/QuantitativePlatform
        if (census != null)
        {
            log.WriteLine("[census] resolved-frame census per thread (freeze desc):");
            foreach (var agg in byThread.Values.OrderByDescending(a => a.FreezeMs).Take(30))
            {
                census.TryGetValue(agg.Tid, out var set);
                int n = set?.Count ?? 0;
                bool hasPump = (set ?? new HashSet<string>()).Any(f => IdleRe.IsMatch(f) || PumpManagedRe.IsMatch(f));
                var interesting = (set ?? new HashSet<string>()).OrderBy(f => f).Take(40).ToList();
                log.WriteLine($"[census] tid={agg.Tid} freeze={agg.FreezeMs:F0}ms idle={agg.IdleMs:F0} cpu={agg.CpuMs:F0} resolvedFrames={n} ui={agg.UiCandidate} pump={hasPump}");
                foreach (var f in interesting) log.WriteLine("   · " + f);
            }
        }

        // ⑦ 进程名过滤（若给了 /process:）
        IEnumerable<ThreadAgg> threads = byThread.Values;
        if (!string.IsNullOrEmpty(procSubstr))
            threads = threads.Where(t => (t.ProcName ?? "").IndexOf(procSubstr, StringComparison.OrdinalIgnoreCase) >= 0);
        var threadList = threads.ToList();

        // ⑧ 选目标线程：优先 /tid；否则**泵消息最多的那条 = 真 UI 线程**（PumpMs 最大，需符号解出 MsgWait）；
        //    再退回 UI 候选里 freeze 最多；再退回全体 freeze 最多。
        ThreadAgg target = null;
        if (wantTid >= 0) target = threadList.FirstOrDefault(t => t.Tid == wantTid);
        if (target == null)
        {
            target = threadList.Where(t => t.PumpMs > 500).OrderByDescending(t => t.PumpMs).FirstOrDefault()
                   ?? threadList.Where(t => t.UiCandidate).OrderByDescending(t => t.FreezeMs).FirstOrDefault()
                   ?? threadList.OrderByDescending(t => t.FreezeMs).FirstOrDefault();
        }

        // ⑧.5 JetBrains/dotTrace 判据：UI 冻结 = **消息泵间隙 > 200ms**（"窗口消息 >200ms 没被泵" 或 "单条消息处理 >200ms"）。
        //     对目标 UI 线程重扫一遍时间线：把样本按时间排开，泵等待(MsgWait)样本切开"处理段"，任一处理段 > 200ms = 一次冻结。
        //     这跟"某线程 blocked 36s"这种把空闲当卡顿的口径**根本不同**——一直在泵=响应，不算冻结。
        const double FREEZE_MS = 200.0;
        var freezeSpans = new List<double[]>();      // [startMs, durMs]
        var freezeSpanStacks = new List<string>();   // 对应的主因栈
        double freezeTotalMs = 0;
        if (target != null)
        {
            int ttid = target.Tid;
            var tl = new List<double[]>();            // [t, dur, isPump]
            var tlStack = new List<string>();
            stackSource.ForEach(s =>
            {
                double sm = s.Metric; if (sm <= 0) return;
                int stid = -1; bool blk = false, pump = false; var rl = new List<string>(48);
                var ci = s.StackIndex;
                while (ci != StackSourceCallStackIndex.Invalid)
                {
                    string nm = stackSource.GetFrameName(stackSource.GetFrameIndex(ci), false);
                    ci = stackSource.GetCallerIndex(ci);
                    if (string.IsNullOrEmpty(nm)) continue;
                    if (nm.StartsWith("BLOCKED_TIME", StringComparison.Ordinal) || nm.StartsWith("LAST_BLOCK", StringComparison.Ordinal)) { blk = true; continue; }
                    if (nm.StartsWith("CPU_TIME", StringComparison.Ordinal)) continue;
                    if (nm.StartsWith("READIED_TIME", StringComparison.Ordinal)) continue;
                    if (nm.IndexOf("(READIED_BY)", StringComparison.Ordinal) >= 0) continue;
                    if (nm.StartsWith("READIED BY", StringComparison.Ordinal)) continue;
                    var mt = TidRe.Match(nm); if (mt.Success) { if (stid < 0) int.TryParse(mt.Groups[1].Value, out stid); continue; }
                    if (nm.StartsWith("Process", StringComparison.Ordinal)) continue;
                    rl.Add(nm);
                }
                if (stid != ttid) return;
                // 栈里出现"等下一条消息"的函数(MsgWaitForMultipleObjects/GetMessage/…)即视为在泵=响应，**不看 blk**
                // （末尾 LAST_BLOCK 的空闲等待可能不带 blk 标记，之前漏判成冻结）。注意只认**等待**函数，
                //  不认 win32k 整体——因为派发(DispatchMessage→WndProc→同步 HttpGet)那条真卡顿也过 win32k。
                if (rl.Any(f => IdleRe.IsMatch(f))) pump = true;
                rl.Reverse();
                tl.Add(new double[] { s.TimeRelativeMSec, sm, pump ? 1 : 0 });
                tlStack.Add(pump ? null : string.Join(";", rl));
            });
            // 按时间排序（保持 stack 对应）
            var order = Enumerable.Range(0, tl.Count).OrderBy(i => tl[i][0]).ToArray();
            double spanStart = -1, spanDur = 0; var spanStacks = new Dictionary<string, double>();
            Action close = () =>
            {
                // 只记有栈可归因的冻结段；无栈段（末尾采样漏栈等）不能当卡顿。
                if (spanStart >= 0 && spanDur >= FREEZE_MS && spanStacks.Count > 0)
                {
                    string dom = spanStacks.OrderByDescending(k => k.Value).First().Key;
                    freezeSpans.Add(new double[] { spanStart, spanDur });
                    freezeSpanStacks.Add(dom);
                    freezeTotalMs += spanDur;
                }
                spanStart = -1; spanDur = 0; spanStacks.Clear();
            };
            foreach (var i in order)
            {
                bool pump = tl[i][2] > 0.5;
                if (pump) { close(); }
                else
                {
                    if (spanStart < 0) spanStart = tl[i][0];
                    spanDur += tl[i][1];
                    var st = tlStack[i];
                    if (!string.IsNullOrEmpty(st)) spanStacks[st] = spanStacks.TryGetValue(st, out var v) ? v + tl[i][1] : tl[i][1];
                }
            }
            close();
            // 按时长排序（保 stack 对应）
            var fo = Enumerable.Range(0, freezeSpans.Count).OrderByDescending(i => freezeSpans[i][1]).ToArray();
            freezeSpans = fo.Select(i => freezeSpans[i]).ToList();
            freezeSpanStacks = fo.Select(i => freezeSpanStacks[i]).ToList();
        }

        // ⑨ 输出人读摘要
        var outSb = new StringBuilder();
        outSb.AppendLine("=== UI Freeze (thread-time) — real PerfView engine via TraceEvent ===");
        outSb.AppendLine($"trace: {input}");
        outSb.AppendLine($"session: {sessionMs:F0} ms   events: {traceLog.EventCount}");
        outSb.AppendLine();
        outSb.AppendLine("top threads by FREEZE time (blocked-but-not-idle):");
        outSb.AppendLine("   tid    pid  process            total    cpu  blocked   idle  FREEZE  ui?");
        foreach (var t in threadList.OrderByDescending(t => t.FreezeMs).Take(12))
        {
            outSb.AppendLine(string.Format(CultureInfo.InvariantCulture,
                "{0,6} {1,6}  {2,-16} {3,7:F0} {4,6:F0} {5,8:F0} {6,6:F0} {7,7:F0}  {8}",
                t.Tid, t.Pid, Trunc(t.ProcName, 16), t.TotalMs, t.CpuMs, t.BlockedMs, t.IdleMs, t.FreezeMs, t.UiCandidate ? "yes" : ""));
        }
        outSb.AppendLine();

        if (target == null)
        {
            outSb.AppendLine("no target thread found (no blocked stacks?). Try /tid or /process.");
            Emit(outSb.ToString(), jsonOut, null);
            return 0;
        }

        outSb.AppendLine($"── target UI thread: tid={target.Tid} pid={target.Pid} ({target.ProcName}) {(target.UiCandidate ? "[UI pump detected]" : "")}");
        outSb.AppendLine($"   total {target.TotalMs:F0} ms  |  CPU {target.CpuMs:F0}  |  blocked {target.BlockedMs:F0}  |  idle(msg-pump) {target.IdleMs:F0}  |  FREEZE {target.FreezeMs:F0} ms");
        outSb.AppendLine($"   pump-wait(响应中/空闲) {target.PumpMs:F0} ms");
        outSb.AppendLine();
        // ★ JetBrains/dotTrace 判据的结果：消息泵间隙 > 200ms 的冻结段
        outSb.AppendLine($"★ UI 冻结（dotTrace 判据：消息泵间隙 > {FREEZE_MS:F0} ms）on tid {target.Tid}:");
        if (freezeSpans.Count == 0)
        {
            outSb.AppendLine("   无 —— 该 UI 线程全程在正常泵消息/响应，没有 >200ms 的卡顿段。");
            outSb.AppendLine("   （注意：上面 blocked/FREEZE 那个大数是「线程阻塞时长」，含空闲等待，≠ UI 卡顿；以本段为准。）");
        }
        else
        {
            outSb.AppendLine($"   冻结 {freezeSpans.Count} 次，合计 {freezeTotalMs:F0} ms，最长 {freezeSpans[0][1]:F0} ms");
            for (int i = 0; i < freezeSpans.Count && i < top; i++)
            {
                var frames = freezeSpanStacks[i].Split(';'); // root->leaf
                outSb.AppendLine($"   • {freezeSpans[i][1]:F0} ms  @ t={freezeSpans[i][0]:F0}ms");
                // 主因看**托管调用链**（UI 线程在干的应用活）；native/内核只作为阻塞点。
                var managed = frames.Where(IsManagedApp).ToList();
                if (managed.Count > 0)
                {
                    outSb.AppendLine("        托管调用链 (root→leaf，近 leaf 10 个)：");
                    int ms0 = Math.Max(0, managed.Count - 10);
                    for (int k = ms0; k < managed.Count; k++) outSb.AppendLine("          " + managed[k]);
                }
                else outSb.AppendLine("        （该段无托管帧——纯 native/等待，或符号未解到应用层）");
                outSb.AppendLine("        阻塞点(leaf): " + frames[frames.Length - 1]);
            }
        }
        outSb.AppendLine();
        outSb.AppendLine($"— 参考：该线程阻塞栈聚合（含空闲，仅供对账）—");
        outSb.AppendLine($"top {top} FREEZE blocking-points (leaf = where it woke from the block):");
        foreach (var kv in target.FreezeLeaves.OrderByDescending(k => k.Value).Take(top))
            if (kv.Value >= minMs)
                outSb.AppendLine($"   {kv.Value,8:F0} ms   {kv.Key}");
        outSb.AppendLine();
        outSb.AppendLine($"top {top} FREEZE stacks (root→leaf), by blocked ms:");
        int rank = 0;
        foreach (var kv in target.FreezeStacks.OrderByDescending(k => k.Value))
        {
            if (kv.Value < minMs) continue;
            if (++rank > top) break;
            outSb.AppendLine($"  [{rank}] {kv.Value:F0} ms");
            var frames = kv.Key.Split(';');
            // 打印最内的 ~18 帧（leaf 侧最有信息量）
            int start = Math.Max(0, frames.Length - 18);
            for (int i = frames.Length - 1; i >= start; i--)
                outSb.AppendLine("        " + frames[i]);
            if (start > 0) outSb.AppendLine($"        … (+{start} caller frames)");
        }

        Emit(outSb.ToString(), jsonOut, BuildJson(input, sessionMs, traceLog.EventCount, threadList, target, top, minMs, FREEZE_MS, freezeSpans, freezeSpanStacks, freezeTotalMs));
        return 0;
    }

    static string Trunc(string s, int n) { s = s ?? ""; return s.Length <= n ? s : s.Substring(0, n); }

    static void Emit(string human, string jsonOut, string json)
    {
        Console.Out.Write(human);
        if (jsonOut != null && json != null)
        {
            File.WriteAllText(jsonOut, json, new UTF8Encoding(false));
            Console.Error.WriteLine("[uifreeze] json → " + jsonOut);
        }
    }

    static string JStr(string s)
    {
        if (s == null) return "null";
        var sb = new StringBuilder(s.Length + 2);
        sb.Append('"');
        foreach (var c in s)
        {
            if (c == '"' || c == '\\') sb.Append('\\').Append(c);
            else if (c == '\n') sb.Append("\\n");
            else if (c == '\r') sb.Append("\\r");
            else if (c == '\t') sb.Append("\\t");
            else if (c < 0x20) sb.Append("\\u").Append(((int)c).ToString("x4"));
            else sb.Append(c);
        }
        sb.Append('"');
        return sb.ToString();
    }
    static string JNum(double d) => d.ToString("F1", CultureInfo.InvariantCulture);

    static string BuildJson(string input, double sessionMs, long events, List<ThreadAgg> threads, ThreadAgg target, int top, double minMs,
                            double freezeThresholdMs, List<double[]> freezeSpans, List<string> freezeSpanStacks, double freezeTotalMs)
    {
        var sb = new StringBuilder();
        sb.Append('{');
        sb.Append("\"trace\":").Append(JStr(input)).Append(',');
        sb.Append("\"sessionMs\":").Append(JNum(sessionMs)).Append(',');
        sb.Append("\"events\":").Append(events).Append(',');
        // ★ dotTrace 判据的结果：消息泵间隙 > 200ms 的冻结段（这是 MCP 侧真正要的数据）
        sb.Append("\"freezeThresholdMs\":").Append(JNum(freezeThresholdMs)).Append(',');
        sb.Append("\"freezeCount\":").Append(freezeSpans != null ? freezeSpans.Count : 0).Append(',');
        sb.Append("\"freezeTotalMs\":").Append(JNum(freezeTotalMs)).Append(',');
        sb.Append("\"freezes\":[");
        if (freezeSpans != null)
        {
            for (int fi = 0; fi < freezeSpans.Count; fi++)
            {
                if (fi > 0) sb.Append(',');
                var frames = (freezeSpanStacks != null && fi < freezeSpanStacks.Count ? freezeSpanStacks[fi] : "").Split(';');
                var managed = frames.Where(IsManagedApp).ToList();
                sb.Append("{\"startMs\":").Append(JNum(freezeSpans[fi][0]))
                  .Append(",\"durMs\":").Append(JNum(freezeSpans[fi][1]))
                  .Append(",\"leaf\":").Append(JStr(frames.Length > 0 ? frames[frames.Length - 1] : ""))
                  .Append(",\"managed\":[");
                int mstart = Math.Max(0, managed.Count - 10);
                for (int k = mstart; k < managed.Count; k++) { if (k > mstart) sb.Append(','); sb.Append(JStr(managed[k])); }
                sb.Append("]}");
            }
        }
        sb.Append("],");
        sb.Append("\"threads\":[");
        int i = 0;
        foreach (var t in threads.OrderByDescending(x => x.FreezeMs).Take(12))
        {
            if (i++ > 0) sb.Append(',');
            sb.Append('{')
              .Append("\"tid\":").Append(t.Tid).Append(',')
              .Append("\"pid\":").Append(t.Pid).Append(',')
              .Append("\"process\":").Append(JStr(t.ProcName)).Append(',')
              .Append("\"totalMs\":").Append(JNum(t.TotalMs)).Append(',')
              .Append("\"cpuMs\":").Append(JNum(t.CpuMs)).Append(',')
              .Append("\"blockedMs\":").Append(JNum(t.BlockedMs)).Append(',')
              .Append("\"idleMs\":").Append(JNum(t.IdleMs)).Append(',')
              .Append("\"freezeMs\":").Append(JNum(t.FreezeMs)).Append(',')
              .Append("\"uiCandidate\":").Append(t.UiCandidate ? "true" : "false")
              .Append('}');
        }
        sb.Append(']');
        if (target != null)
        {
            sb.Append(",\"target\":{")
              .Append("\"tid\":").Append(target.Tid).Append(',')
              .Append("\"pid\":").Append(target.Pid).Append(',')
              .Append("\"process\":").Append(JStr(target.ProcName)).Append(',')
              .Append("\"uiCandidate\":").Append(target.UiCandidate ? "true" : "false").Append(',')
              .Append("\"totalMs\":").Append(JNum(target.TotalMs)).Append(',')
              .Append("\"cpuMs\":").Append(JNum(target.CpuMs)).Append(',')
              .Append("\"blockedMs\":").Append(JNum(target.BlockedMs)).Append(',')
              .Append("\"idleMs\":").Append(JNum(target.IdleMs)).Append(',')
              .Append("\"freezeMs\":").Append(JNum(target.FreezeMs)).Append(',')
              .Append("\"longestSampleMs\":").Append(JNum(target.LongestSampleMs)).Append(',');
            sb.Append("\"topLeaves\":[");
            int j = 0;
            foreach (var kv in target.FreezeLeaves.OrderByDescending(k => k.Value).Take(top))
            {
                if (kv.Value < minMs) continue;
                if (j++ > 0) sb.Append(',');
                sb.Append("{\"frame\":").Append(JStr(kv.Key)).Append(",\"ms\":").Append(JNum(kv.Value)).Append('}');
            }
            sb.Append("],");
            sb.Append("\"topStacks\":[");
            int r = 0;
            foreach (var kv in target.FreezeStacks.OrderByDescending(k => k.Value))
            {
                if (kv.Value < minMs) continue;
                if (r++ >= top) break;
                if (r > 1) sb.Append(',');
                sb.Append("{\"ms\":").Append(JNum(kv.Value)).Append(",\"frames\":[");
                var frames = kv.Key.Split(';');
                for (int k = 0; k < frames.Length; k++)
                {
                    if (k > 0) sb.Append(',');
                    sb.Append(JStr(frames[k]));
                }
                sb.Append("]}");
            }
            sb.Append(']');
            sb.Append('}');
        }
        sb.Append('}');
        return sb.ToString();
    }
}
