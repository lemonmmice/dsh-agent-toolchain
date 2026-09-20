using System.Buffers.Binary;
using System.Diagnostics;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Text.Json;
using Microsoft.Diagnostics.Runtime;

// DumpStack <dump.dmp> [out.json] [dacPath]
//   --engine auto|minidump|dbgeng   (default auto: 三个引擎依次降级，见下)
//   --dump <path>  --out <path>  --dac <path>  --dac-dir <dir>
// 解析 .NET (Framework/Core) 完整 dump，输出所有线程的托管调用栈 JSON。
// 供 dsh-hang-inspector 的自动分析路由使用：定位卡死线程 → 映射项目源码。
//
// ── 三个引擎（auto 依次降级：前一档失败才走下一档）────────────────────────────
//   ClrMD-Minidump            ClrMD 的 minidump reader，常态路径
//   ClrMD-Minidump-Wow64X86   x64 格式的 WOW64 dump 专用：把底层 reader 装饰成 X86/4
//                             视图（Wow64X86Reader），x86 DAC 才装得上
//   ClrMD-DbgEng              反射构造 ClrMD internal DbgEngDataReader（x86 dbgeng.dll），
//                             需要 x86 helper 进程 + exe 目录自带 dbgeng/dbghelp/dbgcore
//
// ── x64 格式（WOW64）dump（2026-09-20 补）────────────────────────────────────
// 用 **64 位宿主**抓 32 位进程（64 位任务管理器的"创建转储文件"、64 位 procdump、64 位
// PowerShell 调 MiniDumpWriteDump）得到的是 **x64 格式**的 WOW64 dump：头里
// SystemInfo=AMD64/ptr=8，但里面的 CLR 是 32 位的（模块在 \Framework\ 而非 Framework64）。
// 这时 minidump 与 dbgeng 两条路都报 AMD64/8，x86 DAC 一律装不上
// （0x80131c30 = CORDBG_E_UNCOMPATIBLE_PLATFORMS）。
// WinDbg 的 `.effmach x86` 能解决，但 ClrMD 只暴露了 effective processor 的 getter；
// 按 COM vtable 直接调 SetEffectiveProcessorType 实测返回 E_INVALIDARG，这条路已放弃。
// 现行方案不改 dbgeng，而是在 reader 层装饰：Wow64X86Reader 把 Architecture/PointerSize
// 报成 X86/4、GetThreadContext 把 AMD64 CONTEXT 翻译成 x86（见该类注释）。
// 走这条路的判据是 LooksLike32BitClr() 给出的证据（clr.dll/mscorwks.dll 在 \Framework\），
// 不按 arch 猜 —— 真正的 64 位进程 dump 绝不能被当成 WOW64 处理。
//
// 构建：**必须 win-x86**（`dotnet publish -c Release -r win-x86`）。x64 宿主进程装不了
// 32 位 DAC，拿它去解 32 位目标只会得到误导性的 DAC 报错。

return DumpStackProgram.Main(args);

static class DumpStackProgram
{
    public static int Main(string[] args)
    {
        if (args.Length < 1)
        {
            Console.Error.WriteLine("usage: DumpStack <dump.dmp> [out.json] [dacPath] [--engine auto|minidump|dbgeng] [--dac-dir <dir>]");
            return 1;
        }

        // dacinfo <dump> — 打印 CLR 核心模块的符号服务器键（timestamp|size），用于下载匹配 DAC
        if (args.Length >= 2 && args[0] == "dacinfo")
        {
            return DacInfo(args[1]);
        }

        // dbginfo [dump] — 反射打印 ClrMD internal DbgEng 类型结构（排障探针，正常路径不调用）。
        if (args.Length >= 1 && args[0] == "dbginfo")
        {
            return DbgInfo(args.Length >= 2 ? args[1] : null);
        }

        // heapstats <dump> [topN] [dacPath] — 托管堆类型统计 Top N（对象数/总大小），供内存泄漏初筛
        if (args.Length >= 2 && args[0] == "heapstats")
        {
            int topN = args.Length >= 3 && int.TryParse(args[2], out var n) ? n : 30;
            string? dacPathArg = args.Length >= 4 ? args[3] : null;
            return HeapStats(args[1], topN, dacPathArg);
        }

        // 主分析：位置参数 (dump, out, dac) + flags 混用
        var pos = new List<string>();
        string engine = "auto";
        string? dumpPath = null, outPath = null, dacPath = null, dacDir = null;
        for (int i = 0; i < args.Length; i++)
        {
            switch (args[i])
            {
                case "--engine":
                    if (++i < args.Length) engine = args[i].ToLowerInvariant();
                    break;
                case "--dump":
                    if (++i < args.Length) dumpPath = args[i];
                    break;
                case "--out":
                    if (++i < args.Length) outPath = args[i];
                    break;
                case "--dac":
                    if (++i < args.Length) dacPath = args[i];
                    break;
                case "--dac-dir":
                    if (++i < args.Length) dacDir = args[i];
                    break;
                default:
                    if (args[i].StartsWith("--")) break;
                    pos.Add(args[i]);
                    break;
            }
        }
        if (dumpPath is null && pos.Count > 0) dumpPath = pos[0];
        if (outPath is null && pos.Count > 1) outPath = pos[1];
        if (dacPath is null && pos.Count > 2) dacPath = pos[2];

        if (dumpPath is null || !File.Exists(dumpPath))
        {
            Console.Error.WriteLine($"dump not found: {dumpPath}");
            return 1;
        }

        return RunAnalysis(dumpPath, outPath, dacPath, dacDir, engine);
    }

    static int DacInfo(string dump)
    {
        try
        {
            using var dt = DataTarget.LoadDump(dump);
            foreach (var m in dt.EnumerateModules())
            {
                var n = Path.GetFileName(m.FileName ?? "");
                if (n.Equals("mscorwks.dll", StringComparison.OrdinalIgnoreCase) ||
                    n.Equals("clr.dll", StringComparison.OrdinalIgnoreCase) ||
                    n.Equals("coreclr.dll", StringComparison.OrdinalIgnoreCase))
                {
                    Console.WriteLine($"{n}|{m.IndexTimeStamp:x8}|{m.IndexFileSize:x}");
                }
            }
            return 0;
        }
        catch (Exception ex)
        {
            Console.Error.WriteLine(ex.ToString());
            return 3;
        }
    }

    /// <summary>
    /// 反射探针：打印 ClrMD 内部 DbgEng 相关类型的构造/字段/属性/方法，并在给定 dump 上遍历
    /// reader 对象图。用于排查「DbgEng 路径为什么没按预期工作」。
    /// </summary>
    static int DbgInfo(string? dumpPath)
    {
        var asm = typeof(DataTarget).Assembly;
        Console.WriteLine($"assembly={asm.GetName().Name} {asm.GetName().Version}");

        foreach (var t in asm.GetTypes().Where(t => (t.Namespace ?? "").Contains("DbgEng")).OrderBy(t => t.FullName))
            Console.WriteLine($"type {(t.IsPublic ? "public  " : "internal")} {t.FullName}");

        // 名字里带 DbgEng/DataReader 的（DbgEngDataReader 实际在顶层命名空间，不在 .DbgEng 下）
        Console.WriteLine("\n== types matching *DbgEng* or *DataReader*");
        foreach (var t in asm.GetTypes().Where(t => t.Name.Contains("DbgEng") || t.Name.Contains("DataReader")).OrderBy(t => t.FullName))
            Console.WriteLine($"   {(t.IsPublic ? "public  " : "internal")} {t.FullName}");

        var readerType = asm.GetTypes().FirstOrDefault(t => t.Name == "DbgEngDataReader");
        if (readerType is null) { Console.WriteLine("DbgEngDataReader NOT FOUND"); return 2; }

        Console.WriteLine($"\n== {readerType.FullName} ctors");
        foreach (var c in readerType.GetConstructors(BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Instance))
            Console.WriteLine($"   ({string.Join(", ", c.GetParameters().Select(p => p.ParameterType.Name + " " + p.Name))})");

        Console.WriteLine($"\n== instance fields");
        foreach (var f in readerType.GetFields(BindingFlags.Instance | BindingFlags.NonPublic | BindingFlags.Public))
            Console.WriteLine($"   {f.FieldType.FullName} {f.Name}");

        Console.WriteLine($"\n== instance properties");
        foreach (var p in readerType.GetProperties(BindingFlags.Instance | BindingFlags.NonPublic | BindingFlags.Public))
            Console.WriteLine($"   {p.PropertyType.Name} {p.Name}");

        if (dumpPath is null) return 0;

        var options = new DataTargetOptions();
        var ctor = readerType.GetConstructor(BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Instance,
            null, new[] { typeof(string), typeof(DataTargetLimits) }, null);
        if (ctor is null) { Console.WriteLine("reader ctor(string, DataTargetLimits) NOT FOUND"); return 3; }

        var reader = ctor.Invoke(new object[] { dumpPath, options.Limits });
        var idr = reader as IDataReader;
        Console.WriteLine($"\n== reader runtime={reader!.GetType().FullName} arch={idr?.Architecture} ptr={idr?.PointerSize}");
        DumpGraph(reader, 0);

        foreach (var tn in new[]
                 {
                     "Microsoft.Diagnostics.Runtime.IDataReader",
                     "Microsoft.Diagnostics.Runtime.DbgEng.DebugControl",
                     "Microsoft.Diagnostics.Runtime.DbgEng.IDebugControlVTable",
                     "Microsoft.Diagnostics.Runtime.DbgEng.DebugClient",
                 })
        {
            var t2 = asm.GetType(tn);
            if (t2 is null) continue;
            Console.WriteLine($"\n== {tn} members");
            foreach (var m in t2.GetMethods(BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Instance | BindingFlags.Static).OrderBy(m => m.Name))
                Console.WriteLine($"   {(m.IsPublic ? "pub " : "int ")}{m.ReturnType.Name} {m.Name}({string.Join(", ", m.GetParameters().Select(p => p.ParameterType.Name))})");

            Console.WriteLine($"-- {tn} FIELDS (offset => index)");
            foreach (var f in t2.GetFields(BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Instance))
            {
                int off;
                try { off = (int)Marshal.OffsetOf(t2, f.Name); } catch { off = -1; }
                Console.WriteLine($"   off=0x{off:X4} idx={off / IntPtr.Size,3}  {f.FieldType.Name} {f.Name}");
            }
        }
        return 0;
    }

    static void DumpGraph(object obj, int depth)
    {
        if (depth > 3) return;
        var t = obj.GetType();
        var pad = new string(' ', depth * 2 + 3);
        foreach (var f in t.GetFields(BindingFlags.Instance | BindingFlags.NonPublic | BindingFlags.Public))
        {
            object? v;
            try { v = f.GetValue(obj); } catch { continue; }
            if (v is null) continue;
            var vt = v.GetType();
            var methods = vt.GetMethods(BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Instance);
            var hasEff = methods.Any(m => m.Name.Contains("EffectiveProcessor"));
            Console.WriteLine($"{pad}{f.Name} : {vt.FullName}{(hasEff ? "   <<< HAS EffectiveProcessor" : "")}");
            if (hasEff)
            {
                foreach (var m in methods.Where(m => m.Name.Contains("EffectiveProcessor")))
                    Console.WriteLine($"{pad}    -> {m.ReturnType.Name} {m.Name}({string.Join(", ", m.GetParameters().Select(p => p.ParameterType.Name))})");
            }
            if (depth < 2 && (vt.Namespace ?? "").Contains("DbgEng")) DumpGraph(v, depth + 1);
        }
    }

    static int HeapStats(string dump, int topN, string? dacPath)
    {
        try
        {
            using var dt = DataTarget.LoadDump(dump);
            ClrRuntime? hrt = null;
            foreach (var ver in dt.ClrVersions)
            {
                try
                {
                    var r = dacPath is null ? ver.CreateRuntime() : ver.CreateRuntime(dacPath);
                    if (r is { Heap: { } }) { hrt = r; break; }
                }
                catch { }
            }
            if (hrt is null)
            {
                foreach (var ver in dt.ClrVersions)
                {
                    try
                    {
                        var r = ver.CreateRuntime(@"C:\Windows\Microsoft.NET\Framework\v4.0.30319\mscordacwks.dll");
                        if (r is { Heap: { } }) { hrt = r; break; }
                    }
                    catch { }
                }
            }
            if (hrt is null) { Console.Error.WriteLine("no CLR runtime with heap"); return 2; }
            var stats = new Dictionary<string, (long Count, ulong Size)>();
            ulong totalSize = 0;
            long totalCount = 0;
            foreach (var obj in hrt.Heap.EnumerateObjects())
            {
                totalCount++;
                totalSize += obj.Size;
                var tn = obj.Type?.Name ?? "<unknown>";
                if (stats.TryGetValue(tn, out var s)) stats[tn] = (s.Count + 1, s.Size + obj.Size);
                else stats[tn] = (1, obj.Size);
            }
            var top = stats.OrderByDescending(kv => kv.Value.Size).Take(topN)
                .Select(kv => new { type = kv.Key, count = kv.Value.Count, sizeBytes = kv.Value.Size })
                .ToList();
            Console.WriteLine(JsonSerializer.Serialize(new { dump, totalObjects = totalCount, totalSizeBytes = totalSize, top }));
            return 0;
        }
        catch (Exception ex)
        {
            Console.Error.WriteLine(ex.ToString());
            return 3;
        }
    }

    static int RunAnalysis(string dumpPath, string? outPath, string? dacPath, string? dacDir, string engineMode)
    {
        var sw = Stopwatch.StartNew();
        var warnings = new List<string>();
        string _archText = "";
        try
        {
            // ---- engine 1: MinidumpReader (ClrMD LoadDump) ----
            DataTarget? dt = null;
            ClrRuntime? rt = null;
            string engineUsed = "ClrMD-Minidump";
            string? usedDac = null;
            Exception? minidumpError = null;
            string? clrVersion = null;

            if (engineMode is "auto" or "minidump")
            {
                try
                {
                    (dt, rt, usedDac, clrVersion) = RunWithMinidump(dumpPath, dacPath, dacDir);
                }
                catch (Exception ex)
                {
                    minidumpError = ex;
                    warnings.Add($"MinidumpReader failed: {ex.GetType().Name}: {ex.Message}");
                    dt?.Dispose();
                    dt = null;
                    if (engineMode == "minidump") throw;
                }
            }

            // ---- engine 1.5: x64 格式 WOW64 dump 的 x86 视图（不依赖 dbgeng）----
            if (dt is null && engineMode is "auto" or "minidump")
            {
                try
                {
                    (dt, rt, usedDac, clrVersion) = RunWithWow64X86View(dumpPath, dacPath, dacDir, warnings);
                    engineUsed = "ClrMD-Minidump-Wow64X86";
                }
                catch (Exception ex)
                {
                    warnings.Add($"Wow64X86View failed: {ex.GetType().Name}: {ex.Message}");
                    dt?.Dispose();
                    dt = null;
                    rt = null;
                }
            }

            // ---- engine 2: DbgEng (反射 internal DbgEngDataReader, x86 helper) ----
            if (dt is null)
            {
                (dt, rt, usedDac, clrVersion) = RunWithDbgEng(dumpPath, dacPath, dacDir, warnings);
                engineUsed = "ClrMD-DbgEng";
            }

            if (rt is null)
                throw new InvalidOperationException("no CLR runtime found in dump" + (minidumpError is null ? "" : $"\n(minidump: {minidumpError.Message})"));

            _archText = dt.DataReader.Architecture.ToString();

            var threads = new List<object>();
            foreach (var t in rt.Threads)
            {
                var frames = new List<object>();
                bool uiLikely = false;
                try
                {
                    foreach (var f in t.EnumerateStackTrace())
                    {
                        var type = f.Method?.Type?.Name ?? "";
                        var method = f.Method?.Name ?? "";
                        var module = f.Method?.Type?.Module?.Name ?? "";
                        if ((method == "PushFrame" && type.Contains("Dispatcher")) ||
                            ((method == "Run" || method == "RunInternal") && type.Contains("Application")))
                        {
                            uiLikely = true;
                        }
                        frames.Add(new
                        {
                            type,
                            method,
                            module,
                            ip = f.InstructionPointer.ToString("X"),
                        });
                    }
                }
                catch
                {
                    // skip frames for this thread
                }

                threads.Add(new
                {
                    managedId = t.ManagedThreadId,
                    osId = t.OSThreadId,
                    lockCount = t.LockCount,
                    uiLikely,
                    frames,
                });
            }

            dt.Dispose();

            var json = JsonSerializer.Serialize(new
            {
                dump = dumpPath,
                engine = engineUsed,
                hostArchitecture = RuntimeInformation.ProcessArchitecture.ToString(),
                pointerSize = IntPtr.Size,
                dumpArchitecture = _archText,
                clrArchitecture = _archText,
                clrVersion,
                dacPath = usedDac,
                threadCount = threads.Count,
                warnings,
                confidence = engineUsed == "ClrMD-DbgEng" ? "high" : "high",
                elapsedMs = sw.ElapsedMilliseconds,
                threads,
            });

            if (outPath is not null) File.WriteAllText(outPath, json);
            Console.WriteLine(json);
            return 0;
        }
        catch (Exception ex)
        {
            Console.Error.WriteLine(ex.ToString());
            return 3;
        }
    }

    /// <summary>MinidumpReader 路径：现有逻辑，返回 (dataTarget, runtime, dacPath, clrVersion)。</summary>
    static (DataTarget, ClrRuntime, string?, string?) RunWithMinidump(string dumpPath, string? dacPath, string? dacDir)
    {
        var dt = DataTarget.LoadDump(dumpPath);
        Console.Error.WriteLine($"#diag engine=minidump target={dt.DataReader.TargetPlatform} arch={dt.DataReader.Architecture} ptr={dt.DataReader.PointerSize} clrVersions={dt.ClrVersions.Count()}");

        var dacs = EnumerateDacCandidates(dacPath, dacDir).ToArray();
        string? usedDac = null;
        ClrRuntime? rt = null;
        Exception? lastErr = null;
        foreach (var ver in dt.ClrVersions)
        {
            // 先让 ClrMD 自动定位（符号/缓存），再逐个候选 DAC 显式尝试
            try
            {
                var r = ver.CreateRuntime();
                if (r is { Threads.Length: > 0 })
                {
                    rt = r;
                    Console.Error.WriteLine($"#diag minidump runtime ok (auto dac) clr={ver.Version}");
                    break;
                }
            }
            catch (Exception ex)
            {
                lastErr = ex;
                Console.Error.WriteLine($"#diag minidump CreateRuntime auto failed clr={ver.Version}: {ex.GetType().Name}: {ex.Message}");
            }

            foreach (var dac in dacs)
            {
                try
                {
                    var r = ver.CreateRuntime(dac);
                    if (r is { Threads.Length: > 0 })
                    {
                        rt = r;
                        usedDac = dac;
                        Console.Error.WriteLine($"#diag minidump runtime ok clr={ver.Version} dac={dac}");
                        break;
                    }
                }
                catch (Exception ex)
                {
                    lastErr = ex;
                    Console.Error.WriteLine($"#diag minidump dac={dac}: {ex.GetType().Name}: {ex.Message}");
                }
            }
            if (rt is not null) break;
        }

        if (rt is null)
        {
            dt.Dispose();
            throw new InvalidOperationException("no CLR runtime found in dump" + (lastErr is null ? "" : $" (last CreateRuntime error: {lastErr.GetType().Name}: {lastErr.Message})"));
        }

        string clrVersion = dt.ClrVersions.Select(v => v.Version.ToString()).FirstOrDefault() ?? "";
        return (dt, rt, usedDac, clrVersion);
    }

    /// <summary>
    /// DbgEng 路径：反射构造 internal Microsoft.Diagnostics.Runtime.DbgEngDataReader(string, DataTargetLimits)，
    /// 再用 public DataTarget(IDataReader, DataTargetOptions) 包装。x86 helper 下 DbgEng 对**原生 32 位 dump**
    /// 会给出正确的 X86/4 架构（实测 4.0.732401 成功）；对 **x64 格式的 WOW64 dump** 报 X64/8 ——
    /// 那种 dump 归上一档 Wow64X86Reader 处理，走到这里说明它也没成，此处不再尝试改架构。
    /// </summary>
    static (DataTarget, ClrRuntime, string?, string?) RunWithDbgEng(string dumpPath, string? dacPath, string? dacDir, List<string> warnings)
    {
        var sw = Stopwatch.StartNew();
        var asm = typeof(DataTarget).Assembly;
        Type readerType = asm.GetType("Microsoft.Diagnostics.Runtime.DbgEngDataReader", throwOnError: true)!;
        var ctor = readerType.GetConstructor(BindingFlags.Public | BindingFlags.Instance, null,
            new[] { typeof(string), typeof(DataTargetLimits) }, null);
        if (ctor is null)
            throw new MissingMethodException("Microsoft.Diagnostics.Runtime.DbgEngDataReader(string, DataTargetLimits) not found. ClrMD version: " + asm.GetName().Version);

        var options = new DataTargetOptions();
        IDataReader reader = (IDataReader)ctor.Invoke(new object[] { dumpPath, options.Limits })!;
        var dt = new DataTarget(reader, options);
        Console.Error.WriteLine($"#diag engine=dbgeng reader={reader.GetType().Name} arch={reader.Architecture} ptr={reader.PointerSize} processId={reader.ProcessId} threadSafe={reader.IsThreadSafe} ({sw.ElapsedMilliseconds}ms)");

        if (reader.Architecture != Architecture.X86 || reader.PointerSize != 4)
            warnings.Add($"DbgEng reader arch={reader.Architecture} ptr={reader.PointerSize} (expected X86/4)");

        string? usedDac = null;
        ClrRuntime? rt = null;
        Exception? last = null;
        foreach (var ver in dt.ClrVersions)
        {
            // 先让 ClrMD 自动定位，再逐个候选 DAC 显式尝试
            try
            {
                var r = ver.CreateRuntime();
                if (r is { Threads.Length: > 0 })
                {
                    rt = r;
                    Console.Error.WriteLine($"#diag dbgeng runtime ok (auto dac) clr={ver.Version} ({sw.ElapsedMilliseconds}ms)");
                    break;
                }
            }
            catch (Exception ex)
            {
                last = ex;
                Console.Error.WriteLine($"#diag dbgeng CreateRuntime auto failed clr={ver.Version}: {ex.GetType().Name}: {ex.Message}");
            }

            foreach (var dac in EnumerateDacCandidates(dacPath, dacDir))
            {
                try
                {
                    var r = ver.CreateRuntime(dac);
                    if (r is { Threads.Length: > 0 })
                    {
                        rt = r;
                        usedDac = dac;
                        Console.Error.WriteLine($"#diag dbgeng runtime ok clr={ver.Version} dac={dac} ({sw.ElapsedMilliseconds}ms)");
                        break;
                    }
                }
                catch (Exception ex)
                {
                    last = ex;
                    Console.Error.WriteLine($"#diag dbgeng dac={dac}: {ex.GetType().Name}: {ex.Message}");
                }
            }
            if (rt is not null) break;
        }

        if (rt is null)
        {
            dt.Dispose();
            throw new InvalidOperationException("no CLR runtime via DbgEng" + (last is null ? "" : $": {last.GetType().Name}: {last.Message}"));
        }

        string clrVersion = dt.ClrVersions.Select(v => v.Version.ToString()).FirstOrDefault() ?? "";
        return (dt, rt, usedDac, clrVersion);
    }

    /// <summary>
    /// x64 格式 WOW64 dump 的"x86 视图"：把底层 minidump reader 包一层，对外只报 X86/4，并把
    /// 64 位 CONTEXT 翻译成 x86 CONTEXT。ClrMD 据此把 DAC 数据目标的机器类型报成 i386，x86 DAC
    /// 才装得上（否则 0x80131c30 CORDBG_E_UNCOMPATIBLE_PLATFORMS），之后所有 CLR 结构按 32 位指针解读。
    /// 只改"说得通说不通"的元信息 + 寄存器视图；内存读取原样透传（32 位地址在 dump 里可见）。
    /// </summary>
    sealed class Wow64X86Reader : IDataReader
    {
        private readonly IDataReader _inner;
        public Wow64X86Reader(IDataReader inner) => _inner = inner;

        public Architecture Architecture => Architecture.X86;
        public string DisplayName => _inner.DisplayName + " [wow64->x86 view]";
        public bool IsThreadSafe => _inner.IsThreadSafe;
        public int ProcessId => _inner.ProcessId;
        public OSPlatform TargetPlatform => _inner.TargetPlatform;
        public IEnumerable<ModuleInfo> EnumerateModules() => _inner.EnumerateModules();
        public void FlushCachedData() => _inner.FlushCachedData();

        // IDataReader 继承 IMemoryReader：视图里的指针宽度是 4
        public int PointerSize => 4;
        public int Read(ulong address, Span<byte> buffer) => _inner.Read(address, buffer);
        public bool Read<T>(ulong address, out T value) where T : unmanaged => _inner.Read(address, out value);
        public T Read<T>(ulong address) where T : unmanaged => _inner.Read<T>(address);

        /// <summary>
        /// 指针读取必须按 4 字节零扩展 —— 底层（AMD64 视图）会读 8 字节，把相邻内存一起吃进来，
        /// 那样指针链就全错了。
        /// </summary>
        public bool ReadPointer(ulong address, out ulong pointer)
        {
            pointer = 0;
            Span<byte> buf = stackalloc byte[4];
            if (_inner.Read(address, buf) != 4) return false;
            pointer = BinaryPrimitives.ReadUInt32LittleEndian(buf);
            return true;
        }

        public ulong ReadPointer(ulong address) => ReadPointer(address, out var p) ? p : 0;

        public bool GetThreadContext(uint threadID, uint contextFlags, Span<byte> context)
        {
            // 底层按 dump 自己的架构（AMD64，CONTEXT 约 0x4D0 字节）填；这里给足缓冲再翻译。
            Span<byte> amd64 = stackalloc byte[0x500];
            if (!_inner.GetThreadContext(threadID, contextFlags, amd64)) return false;
            return TranslateAmd64ContextToX86(amd64, context);
        }
    }

    /// <summary>
    /// AMD64 CONTEXT → x86 CONTEXT。WOW64 线程跑在兼容模式下：Rip/Rsp/Rbp 的低 32 位即 Eip/Esp/Ebp。
    /// 偏移取自 winnt.h（CONTEXT 的 amd64 / x86 两个布局）。
    /// </summary>
    static bool TranslateAmd64ContextToX86(ReadOnlySpan<byte> a, Span<byte> x)
    {
        if (a.Length < 0x100 || x.Length < 0xCC) return false;
        x.Clear();

        static uint Lo64(ReadOnlySpan<byte> s, int off) => (uint)BinaryPrimitives.ReadUInt64LittleEndian(s.Slice(off));
        static ushort W16(ReadOnlySpan<byte> s, int off) => BinaryPrimitives.ReadUInt16LittleEndian(s.Slice(off));
        static void W32(Span<byte> s, int off, uint v) => BinaryPrimitives.WriteUInt32LittleEndian(s.Slice(off), v);

        const uint AMD64_BASE = 0x00100000;   // CONTEXT_AMD64
        const uint I386_BASE = 0x00010000;    // CONTEXT_i386
        uint flags = BinaryPrimitives.ReadUInt32LittleEndian(a.Slice(0x30));
        W32(x, 0x00, I386_BASE | (flags & ~AMD64_BASE));

        // 调试寄存器 Dr0/1/2/3/6/7
        W32(x, 0x04, Lo64(a, 0x48));
        W32(x, 0x08, Lo64(a, 0x50));
        W32(x, 0x0C, Lo64(a, 0x58));
        W32(x, 0x10, Lo64(a, 0x60));
        W32(x, 0x14, Lo64(a, 0x68));
        W32(x, 0x18, Lo64(a, 0x70));

        // 段寄存器（x86 布局顺序：Gs, Fs, Es, Ds）
        W32(x, 0x8C, W16(a, 0x40));   // SegGs
        W32(x, 0x90, W16(a, 0x3E));   // SegFs
        W32(x, 0x94, W16(a, 0x3C));   // SegEs
        W32(x, 0x98, W16(a, 0x3A));   // SegDs

        // 通用寄存器
        W32(x, 0x9C, Lo64(a, 0xB0));  // Edi <- Rdi
        W32(x, 0xA0, Lo64(a, 0xA8));  // Esi <- Rsi
        W32(x, 0xA4, Lo64(a, 0x90));  // Ebx <- Rbx
        W32(x, 0xA8, Lo64(a, 0x88));  // Edx <- Rdx
        W32(x, 0xAC, Lo64(a, 0x80));  // Ecx <- Rcx
        W32(x, 0xB0, Lo64(a, 0x78));  // Eax <- Rax
        W32(x, 0xB4, Lo64(a, 0xA0));  // Ebp <- Rbp
        W32(x, 0xB8, Lo64(a, 0xF8));  // Eip <- Rip
        W32(x, 0xBC, W16(a, 0x38));   // SegCs
        W32(x, 0xC0, BinaryPrimitives.ReadUInt32LittleEndian(a.Slice(0x44))); // EFlags
        W32(x, 0xC4, Lo64(a, 0x98));  // Esp <- Rsp
        W32(x, 0xC8, W16(a, 0x42));   // SegSs
        return true;
    }

    /// <summary>
    /// 引擎：x64 格式 WOW64 dump + 32 位 CLR ⇒ 用 Wow64X86Reader 包底层 minidump reader，
    /// 让 x86 DAC 装得上。非该情形时抛异常（调用方会捕获并继续走别的引擎）。
    /// </summary>
    static (DataTarget, ClrRuntime, string?, string?) RunWithWow64X86View(string dumpPath, string? dacPath, string? dacDir, List<string> warnings)
    {
        // 探针 DataTarget 只用来判定 + 提供底层 reader；必须一直活着（外层 DataTarget 依赖它）。
        var probe = DataTarget.LoadDump(dumpPath);
        if (probe.DataReader.Architecture == Architecture.X86)
        {
            probe.Dispose();
            throw new InvalidOperationException("dump 已经是 x86 视图，无需 WOW64 转换");
        }
        if (!LooksLike32BitClr(probe, out var evidence))
        {
            probe.Dispose();
            throw new InvalidOperationException($"dump 里没找到 32 位 CLR（{evidence}）");
        }

        var view = new Wow64X86Reader(probe.DataReader);
        var dt = new DataTarget(view, new DataTargetOptions());
        Console.Error.WriteLine($"#diag engine=wow64-x86-view innerArch={probe.DataReader.Architecture} viewArch={view.Architecture} ({evidence})");

        string? usedDac = null;
        ClrRuntime? rt = null;
        Exception? lastErr = null;
        foreach (var ver in dt.ClrVersions)
        {
            try
            {
                var r = ver.CreateRuntime();
                if (r is { Threads.Length: > 0 })
                {
                    rt = r;
                    Console.Error.WriteLine($"#diag wow64-x86-view runtime ok (auto dac) clr={ver.Version}");
                    break;
                }
            }
            catch (Exception ex)
            {
                lastErr = ex;
                Console.Error.WriteLine($"#diag wow64-x86-view CreateRuntime auto failed clr={ver.Version}: {ex.GetType().Name}: {ex.Message}");
            }

            foreach (var dac in EnumerateDacCandidates(dacPath, dacDir))
            {
                try
                {
                    var r = ver.CreateRuntime(dac);
                    if (r is { Threads.Length: > 0 })
                    {
                        rt = r;
                        usedDac = dac;
                        Console.Error.WriteLine($"#diag wow64-x86-view runtime ok clr={ver.Version} dac={dac}");
                        break;
                    }
                }
                catch (Exception ex)
                {
                    lastErr = ex;
                    Console.Error.WriteLine($"#diag wow64-x86-view dac={dac}: {ex.GetType().Name}: {ex.Message}");
                }
            }
            if (rt is not null) break;
        }

        if (rt is null)
        {
            dt.Dispose();
            probe.Dispose();
            throw new InvalidOperationException("no CLR runtime via Wow64X86Reader"
                + (lastErr is null ? "" : $" (last: {lastErr.GetType().Name}: {lastErr.Message})"));
        }

        warnings.Add($"WOW64 dump（x64 格式 + 32 位 CLR，{evidence}）：已按 x86 视图解析（CONTEXT 由 AMD64 翻译，指针宽度 4）");
        string clrVersion = dt.ClrVersions.Select(v => v.Version.ToString()).FirstOrDefault() ?? "";
        return (dt, rt, usedDac, clrVersion);
    }

    /// <summary>
    /// dump 里的 CLR 是不是 32 位：看 clr.dll / mscorwks.dll 的路径在 \Framework\ 还是 \Framework64\。
    /// 用来区分"x64 格式的 WOW64 dump"（可套 x86 视图）与"真正的 64 位进程 dump"（绝不能套）。
    /// </summary>
    static bool LooksLike32BitClr(DataTarget dt, out string evidence)
    {
        evidence = "";
        try
        {
            foreach (var m in dt.EnumerateModules())
            {
                var file = m.FileName ?? "";
                var n = Path.GetFileName(file);
                if (!n.Equals("clr.dll", StringComparison.OrdinalIgnoreCase) &&
                    !n.Equals("mscorwks.dll", StringComparison.OrdinalIgnoreCase) &&
                    !n.Equals("coreclr.dll", StringComparison.OrdinalIgnoreCase)) continue;

                bool x86 = file.Contains(@"\Framework\", StringComparison.OrdinalIgnoreCase)
                           && !file.Contains("Framework64", StringComparison.OrdinalIgnoreCase);
                evidence = $"{n} => {file}";
                return x86;
            }
            evidence = "no clr module found in dump";
            return false;
        }
        catch (Exception ex)
        {
            evidence = $"enumerate modules failed: {ex.GetType().Name}: {ex.Message}";
            return false;
        }
    }

    /// <summary>DAC 候选：显式 --dac → --dac-dir 下所有 mscordacwks*.dll → 本机 Framework/Framework64。去重保持顺序。</summary>
    static IEnumerable<string> EnumerateDacCandidates(string? dacPath, string? dacDir)
    {
        var seen = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        if (!string.IsNullOrEmpty(dacPath) && File.Exists(dacPath) && seen.Add(dacPath))
            yield return dacPath;

        if (!string.IsNullOrEmpty(dacDir) && Directory.Exists(dacDir))
        {
            foreach (var f in Directory.EnumerateFiles(dacDir, "mscordacwks*.dll", SearchOption.TopDirectoryOnly).OrderBy(f => f, StringComparer.OrdinalIgnoreCase))
                if (seen.Add(f)) yield return f;
        }

        string[] system = new[]
        {
            @"C:\Windows\Microsoft.NET\Framework\v4.0.30319\mscordacwks.dll",
            @"C:\Windows\Microsoft.NET\Framework64\v4.0.30319\mscordacwks.dll",
        };
        foreach (var f in system)
            if (File.Exists(f) && seen.Add(f)) yield return f;
    }
}
