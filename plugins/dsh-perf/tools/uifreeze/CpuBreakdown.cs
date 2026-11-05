using System;
using System.Collections.Generic;
using System.IO;
using System.IO.Compression;
using System.Linq;
using System.Text.Json;
using Microsoft.Diagnostics.Tracing.Etlx;
using Microsoft.Diagnostics.Tracing.Parsers.Kernel;

internal static class CpuBreakdown
{
    internal sealed class Group
    {
        public string Name { get; set; }
        public string[] Patterns { get; set; }
    }

    internal sealed class Request
    {
        public string EtlPath { get; set; }
        public int Pid { get; set; }
        public int? Tid { get; set; }
        public double StartMs { get; set; }
        public double? EndMs { get; set; }
        public int Top { get; set; } = 15;
        public int BinMs { get; set; } = 100;
        public Group[] Groups { get; set; } = Array.Empty<Group>();
    }

    internal sealed class Count
    {
        public long Samples;
        public long LeafSamples;
        public double? FirstMs;
        public double? LastMs;

        public void Add(double time)
        {
            Samples++;
            FirstMs = FirstMs.HasValue ? Math.Min(FirstMs.Value, time) : time;
            LastMs = LastMs.HasValue ? Math.Max(LastMs.Value, time) : time;
        }
    }

    internal sealed class Accumulator
    {
        internal readonly Request Scope;
        internal readonly double EndMs;
        internal readonly double EffectiveBinMs;
        internal long SampleCount;
        internal long MissingStackSamples;
        internal long UnresolvedOnlySamples;
        internal long GroupUnionSamples;
        internal long OverlapSamples;
        internal readonly Count[] Groups;
        internal readonly Dictionary<string, Count> Frames = new Dictionary<string, Count>(StringComparer.Ordinal);
        internal readonly Dictionary<int, Count> Threads = new Dictionary<int, Count>();
        internal readonly Dictionary<int, long[]> Bins = new Dictionary<int, long[]>();
        internal readonly string[][] Examples;
        internal readonly bool[] ExampleTruncated;

        internal Accumulator(Request request, double endMs)
        {
            Validate(request);
            if (!double.IsFinite(endMs) || endMs <= request.StartMs) throw new ArgumentException("Time window does not overlap trace duration");
            Scope = request;
            EndMs = endMs;
            EffectiveBinMs = Math.Max(request.BinMs, Math.Ceiling((endMs - request.StartMs) / 1000));
            Groups = request.Groups.Select(group => new Count()).ToArray();
            Examples = new string[Groups.Length][];
            ExampleTruncated = new bool[Groups.Length];
        }

        internal bool InScope(int pid, int tid, double time)
        {
            return pid == Scope.Pid && (!Scope.Tid.HasValue || tid == Scope.Tid.Value) && time >= Scope.StartMs && time < EndMs;
        }

        internal void Add(int pid, int tid, double time, IReadOnlyList<string> frames, bool hasResolvedFrame)
        {
            if (!InScope(pid, tid, time)) return;
            SampleCount++;
            if (!Threads.TryGetValue(tid, out var thread)) Threads.Add(tid, thread = new Count());
            thread.Add(time);
            int binIndex = (int)Math.Floor((time - Scope.StartMs) / EffectiveBinMs);
            if (!Bins.TryGetValue(binIndex, out var bin)) Bins.Add(binIndex, bin = new long[Groups.Length + 1]);
            bin[0]++;
            if (frames.Count == 0) { MissingStackSamples++; return; }
            if (!hasResolvedFrame) UnresolvedOnlySamples++;
            foreach (string frame in frames.Distinct(StringComparer.Ordinal))
            {
                if (!Frames.TryGetValue(frame, out var count))
                {
                    if (Frames.Count >= 100000) throw new InvalidDataException("More than 100000 unique frames; select a narrower process/thread/time window");
                    Frames.Add(frame, count = new Count());
                }
                count.Add(time);
            }
            Frames[frames[0]].LeafSamples++;
            int matches = 0;
            for (int groupIndex = 0; groupIndex < Groups.Length; groupIndex++)
            {
                if (!frames.Any(frame => Scope.Groups[groupIndex].Patterns.Any(pattern => frame.IndexOf(pattern, StringComparison.OrdinalIgnoreCase) >= 0))) continue;
                matches++;
                Groups[groupIndex].Add(time);
                bin[groupIndex + 1]++;
                if (Examples[groupIndex] == null)
                {
                    Examples[groupIndex] = frames.Take(64).Reverse().ToArray();
                    ExampleTruncated[groupIndex] = frames.Count > 64;
                }
            }
            if (matches > 0) GroupUnionSamples++;
            if (matches > 1) OverlapSamples++;
        }

        internal object Report(string tracePath, string analyzedPath, DateTime traceStart, double durationMs)
        {
            double Percent(long count) => SampleCount == 0 ? 0 : Math.Round(100.0 * count / SampleCount, 3);
            double? Span(Count count) => count.LastMs.HasValue ? Math.Round(count.LastMs.Value - count.FirstMs.Value, 3) : null;
            return new
            {
                version = 1,
                ok = SampleCount > 0,
                code = SampleCount > 0 ? "OK" : "NO_CPU_SAMPLES",
                error = SampleCount > 0 ? null : "No CPU samples for this process/thread/time window; this does not prove zero work",
                tracePath, analyzedPath, traceStart, durationMs,
                scope = new { pid = Scope.Pid, tid = Scope.Tid, startMs = Scope.StartMs, endMs = EndMs, requestedEndMs = Scope.EndMs, interval = "[startMs, endMs)" },
                sampleCount = SampleCount,
                missingStackSamples = MissingStackSamples,
                stackCoveragePercent = Percent(SampleCount - MissingStackSamples),
                unresolvedOnlySamples = UnresolvedOnlySamples,
                groupUnionSamples = GroupUnionSamples,
                overlapSamples = OverlapSamples,
                groups = Scope.Groups.Select((group, index) => new
                {
                    name = group.Name, patterns = group.Patterns, samples = Groups[index].Samples,
                    percent = Percent(Groups[index].Samples), firstSampleMs = Groups[index].FirstMs,
                    lastSampleMs = Groups[index].LastMs, sampleSpanMs = Span(Groups[index]),
                    exampleStack = Examples[index] ?? Array.Empty<string>(), exampleTruncated = ExampleTruncated[index],
                }),
                topFrames = Frames.OrderByDescending(pair => pair.Value.Samples).ThenBy(pair => pair.Key, StringComparer.Ordinal).Take(Scope.Top).Select(pair => new
                {
                    frame = pair.Key, inclusiveSamples = pair.Value.Samples, leafSamples = pair.Value.LeafSamples,
                    percent = Percent(pair.Value.Samples), firstSampleMs = pair.Value.FirstMs,
                    lastSampleMs = pair.Value.LastMs, sampleSpanMs = Span(pair.Value),
                }),
                threads = Threads.OrderByDescending(pair => pair.Value.Samples).Take(Scope.Top).Select(pair => new { tid = pair.Key, samples = pair.Value.Samples, percent = Percent(pair.Value.Samples) }),
                uniqueFrames = Frames.Count, uniqueThreads = Threads.Count,
                effectiveBinMs = EffectiveBinMs,
                timeline = Bins.OrderBy(pair => pair.Key).Select(pair => new
                {
                    startMs = Scope.StartMs + pair.Key * EffectiveBinMs,
                    endMs = Math.Min(EndMs, Scope.StartMs + (pair.Key + 1) * EffectiveBinMs),
                    samples = pair.Value[0], groupSamples = pair.Value.Skip(1).ToArray(),
                }),
                measurementScope = new
                {
                    unit = "CPU samples, not milliseconds",
                    groups = "Case-insensitive literal substring OR; each sample counted once per group. Inclusive groups may overlap and must not be added.",
                    span = "Last minus first observed CPU sample, not method execution duration or screen presentation latency.",
                    coverage = "Missing stacks and unresolved symbols can hide work. Zero matching samples is not proof a method never executed. No off-CPU/wait analysis.",
                    timeline = "Only nonempty bins; groupSamples uses groups order. At most 1000 bins, enlarged automatically for long windows.",
                    example = "First matching stack, root-to-leaf; limited to the 64 leaf-side frames, not a hottest or causal stack.",
                    symbols = "Uses names already present in ETLX/CLR rundown. Does not download native symbols or infer a main UI thread.",
                },
            };
        }
    }

    internal static void Validate(Request request)
    {
        if (request == null || request.Pid <= 0 || request.Tid <= 0 || !double.IsFinite(request.StartMs) || request.StartMs < 0
            || (request.EndMs.HasValue && (!double.IsFinite(request.EndMs.Value) || request.EndMs <= request.StartMs))
            || request.Top < 1 || request.Top > 50 || request.BinMs < 1 || request.BinMs > 60000
            || request.Groups == null || request.Groups.Length > 32) throw new ArgumentException("Invalid CPU breakdown scope or limits");
        var names = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        foreach (var group in request.Groups)
        {
            if (group == null || string.IsNullOrWhiteSpace(group.Name) || group.Name.Length > 80 || !names.Add(group.Name)
                || group.Patterns == null || group.Patterns.Length < 1 || group.Patterns.Length > 16
                || group.Patterns.Any(pattern => string.IsNullOrWhiteSpace(pattern) || pattern.Length > 256)) throw new ArgumentException("Invalid or duplicate CPU group");
        }
    }

    internal static int Run(string[] args)
    {
        if (args.Length != 2) { Console.Error.WriteLine("usage: UiFreezeStacks /cpu request.json report.json"); return 2; }
        try
        {
            var options = new JsonSerializerOptions { PropertyNameCaseInsensitive = true, WriteIndented = true };
            var request = JsonSerializer.Deserialize<Request>(File.ReadAllText(args[0]), options);
            Validate(request);
            string input = Path.GetFullPath(request.EtlPath);
            string directory = Path.GetDirectoryName(Path.GetFullPath(args[1]));
            string analyzedPath = input;
            if (input.EndsWith(".etl.zip", StringComparison.OrdinalIgnoreCase))
            {
                using var archive = ZipFile.OpenRead(input);
                var entries = archive.Entries.Where(entry => entry.FullName.EndsWith(".etl", StringComparison.OrdinalIgnoreCase)).ToArray();
                if (entries.Length != 1) throw new InvalidDataException("Archive must contain exactly one ETL");
                analyzedPath = Path.Combine(directory, "input.etl");
                using var source = entries[0].Open();
                using var destination = new FileStream(analyzedPath, FileMode.CreateNew);
                source.CopyTo(destination);
            }
            if (analyzedPath.EndsWith(".etl", StringComparison.OrdinalIgnoreCase))
                analyzedPath = TraceLog.CreateFromEventTraceLogFile(analyzedPath, Path.Combine(directory, "input.etlx"), new TraceLogOptions { ConversionLog = Console.Error });
            else if (!analyzedPath.EndsWith(".etlx", StringComparison.OrdinalIgnoreCase)) throw new ArgumentException("Expected ETLX, ETL or ETL.ZIP");

            using var trace = new TraceLog(analyzedPath);
            double durationMs = trace.SessionDuration.TotalMilliseconds;
            var accumulator = new Accumulator(request, Math.Min(request.EndMs ?? durationMs, durationMs));
            foreach (var sample in trace.Events.ByEventType<SampledProfileTraceData>())
            {
                if (!accumulator.InScope(sample.ProcessID, sample.ThreadID, sample.TimeStampRelativeMSec)) continue;
                var frames = new List<string>();
                bool resolved = false;
                for (var frame = sample.CallStack(); frame != null; frame = frame.Caller)
                {
                    if (frames.Count >= 4096) throw new InvalidDataException("Stack exceeds 4096 frames");
                    var address = frame.CodeAddress;
                    string name = address.FullMethodName;
                    resolved |= !string.IsNullOrEmpty(name);
                    string label = address.ModuleName + "!" + (string.IsNullOrEmpty(name) ? "0x" + address.Address.ToString("x") : name);
                    if (label.Length > 4096) throw new InvalidDataException("Frame name exceeds 4096 characters");
                    frames.Add(label);
                }
                accumulator.Add(sample.ProcessID, sample.ThreadID, sample.TimeStampRelativeMSec, frames, resolved);
            }
            using var output = new FileStream(args[1], FileMode.CreateNew);
            JsonSerializer.Serialize(output, accumulator.Report(input, analyzedPath, trace.SessionStartTime, durationMs), options);
            return 0;
        }
        catch (Exception error)
        {
            Console.Error.WriteLine(error.GetType().Name + ": " + error.Message);
            return 1;
        }
    }
}
