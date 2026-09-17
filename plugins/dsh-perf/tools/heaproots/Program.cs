// HeapRoots — dsh-perf #2「堆 GC root / 保留链」分析器（ClrMD）。
// 用法：HeapRoots <dump.dmp> [--type <子串>] [--top N] [--paths P] [--dac <dir>] [--max-objects N]
//   无 --type：只出托管堆 Top 类型（对象数/字节）——与 perf_heap 同口径的自足census。
//   有 --type：额外对该类型的对象做 GC root → 对象 的**保留链**（回答"谁 keep 住了它"）。
// 输出：一行 JSON 到 stdout（失败 JSON 带 ok:false + error，非 0 退出码）。
using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Text.Json;
using Microsoft.Diagnostics.Runtime;

static class Program
{
    static int Main(string[] args)
    {
        string dump = null, typeFilter = null, dac = null;
        int top = 30, paths = 5;
        long maxObjects = 8_000_000;
        for (int i = 0; i < args.Length; i++)
        {
            var a = args[i];
            if (a == "--type" && i + 1 < args.Length) typeFilter = args[++i];
            else if (a == "--top" && i + 1 < args.Length) top = int.Parse(args[++i]);
            else if (a == "--paths" && i + 1 < args.Length) paths = int.Parse(args[++i]);
            else if (a == "--dac" && i + 1 < args.Length) dac = args[++i];
            else if (a == "--max-objects" && i + 1 < args.Length) maxObjects = long.Parse(args[++i]);
            else if (!a.StartsWith("--") && dump == null) dump = a;
        }
        if (dump == null) return Fail("usage: HeapRoots <dump.dmp> [--type <substr>] [--top N] [--paths P] [--dac <dir>]", 2);
        if (!File.Exists(dump)) return Fail("dump not found: " + dump, 2);

        try
        {
            using var dt = DataTarget.LoadDump(dump);
            var clrInfo = dt.ClrVersions.FirstOrDefault();
            if (clrInfo == null) return Fail("这个 dump 里没有 CLR（不是 .NET 进程，或 DAC 不匹配）", 3);
            using var runtime = string.IsNullOrEmpty(dac) ? clrInfo.CreateRuntime() : clrInfo.CreateRuntime(dac);
            var heap = runtime.Heap;
            if (!heap.CanWalkHeap) return Fail("托管堆当前不可遍历（dump 可能是在 GC 中途抓的）", 3);

            // ── 堆 census：按类型汇总（对象数 / 字节）。
            var byType = new Dictionary<string, long[]>(); // name -> [count, bytes]
            long totalCount = 0, totalBytes = 0, walked = 0;
            var targets = typeFilter != null ? new HashSet<ulong>() : null;
            int targetCap = Math.Max(paths * 50, 2000);
            foreach (var obj in heap.EnumerateObjects())
            {
                if (obj.Type == null) continue;
                walked++;
                long sz = (long)obj.Size;
                var name = obj.Type.Name ?? "<unknown>";
                totalCount++; totalBytes += sz;
                if (byType.TryGetValue(name, out var e)) { e[0]++; e[1] += sz; }
                else byType[name] = new long[] { 1, sz };
                if (targets != null && targets.Count < targetCap && name.IndexOf(typeFilter, StringComparison.Ordinal) >= 0)
                    targets.Add(obj.Address);
                if (walked >= maxObjects) break;
            }
            var topList = byType.Select(kv => new { type = kv.Key, count = kv.Value[0], bytes = kv.Value[1] })
                .OrderByDescending(x => x.bytes).Take(top).ToList();

            // ── 有 --type：对该类型对象做 root → 对象 保留链（自实现有界 BFS）。
            List<object> rootPaths = null;
            int rootCount = 0;
            if (typeFilter != null && targets.Count > 0)
                rootPaths = FindRootPaths(heap, targets, paths, maxObjects, out rootCount);

            var outObj = new
            {
                ok = true,
                dump,
                clr = clrInfo.Version.ToString(),
                bitness = dt.DataReader.PointerSize == 8 ? "x64" : "x86",
                walkedObjects = walked,
                cappedWalk = walked >= maxObjects,
                managedTotalObjects = totalCount,
                managedTotalBytes = totalBytes,
                topTypes = topList,
                type = typeFilter,
                typeMatchedObjects = targets?.Count ?? 0,
                rootsEnumerated = rootCount,
                rootPaths,
            };
            Console.WriteLine(JsonSerializer.Serialize(outObj));
            return 0;
        }
        catch (Exception ex)
        {
            return Fail("exception: " + ex.GetType().Name + ": " + ex.Message, 1);
        }
    }

    /// <summary>
    /// 从所有 GC root 起做 BFS，命中 targets 里的对象就回溯出一条"root → … → 对象"的最短保留链。
    /// 只用 EnumerateRoots + EnumerateReferences（稳定 API）。visited/parent 有上限，防在巨堆上跑飞。
    /// </summary>
    static List<object> FindRootPaths(ClrHeap heap, HashSet<ulong> targets, int maxPaths, long visitCap, out int rootCount)
    {
        var parent = new Dictionary<ulong, ulong>();     // child -> parent（root 的 parent = 0）
        var rootInfo = new Dictionary<ulong, string>();  // 种子对象 -> root 种类
        var q = new Queue<ulong>();
        rootCount = 0;
        foreach (var root in heap.EnumerateRoots())
        {
            rootCount++;
            var ro = root.Object;
            if (ro.IsNull) continue;
            var a = ro.Address;
            if (!parent.ContainsKey(a))
            {
                parent[a] = 0UL;
                rootInfo[a] = root.RootKind.ToString();
                q.Enqueue(a);
            }
        }
        var found = new List<object>();
        var remaining = new HashSet<ulong>(targets);
        long visited = 0;
        while (q.Count > 0 && found.Count < maxPaths && visited < visitCap)
        {
            var addr = q.Dequeue();
            visited++;
            if (remaining.Remove(addr))
            {
                found.Add(BuildPath(heap, addr, parent, rootInfo));
                if (remaining.Count == 0) break;
            }
            ClrObject obj;
            try { obj = heap.GetObject(addr); } catch { continue; }
            if (obj.Type == null) continue;
            foreach (var reference in obj.EnumerateReferences(true, true))
            {
                var ca = reference.Address;
                if (ca != 0 && !parent.ContainsKey(ca)) { parent[ca] = addr; q.Enqueue(ca); }
            }
        }
        return found;
    }

    /// <summary>回溯 parent 链（对象 → root），反转成 root → 对象，带类型名。</summary>
    static object BuildPath(ClrHeap heap, ulong target, Dictionary<ulong, ulong> parent, Dictionary<ulong, string> rootInfo)
    {
        var chain = new List<object>();
        var cur = target;
        var guard = 0;
        ulong rootSeed = target;
        while (guard++ < 512)
        {
            string tname;
            try { var o = heap.GetObject(cur); tname = o.Type?.Name ?? "<unknown>"; } catch { tname = "<unreadable>"; }
            chain.Add(new { addr = "0x" + cur.ToString("x"), type = tname });
            if (!parent.TryGetValue(cur, out var p) || p == 0UL) { rootSeed = cur; break; }
            cur = p;
        }
        chain.Reverse(); // 现在是 root → … → target
        return new
        {
            rootKind = rootInfo.TryGetValue(rootSeed, out var rk) ? rk : "Unknown",
            depth = chain.Count,
            chain,
        };
    }

    static int Fail(string msg, int code)
    {
        Console.WriteLine(JsonSerializer.Serialize(new { ok = false, error = msg }));
        return code;
    }
}
