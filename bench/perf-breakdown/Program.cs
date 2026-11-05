using System.Text.Json;

int passed = 0;
void Check(bool value, string message)
{
    if (!value) throw new Exception(message);
    passed++;
}
var request = new CpuBreakdown.Request
{
    Pid = 42, Tid = 9, StartMs = 10, EndMs = 30, BinMs = 5, Top = 3,
    Groups = new[]
    {
        new CpuBreakdown.Group { Name = "View", Patterns = new[] { "view" } },
        new CpuBreakdown.Group { Name = "GIF", Patterns = new[] { "Gif.Decode", "gif" } },
        new CpuBreakdown.Group { Name = "SVG", Patterns = new[] { "svg" } },
        new CpuBreakdown.Group { Name = "Absent", Patterns = new[] { "MissingView" } },
    }
};
var accumulator = new CpuBreakdown.Accumulator(request, 30);
string[] recursive = { "Lib!Gif.Decode", "App!View..ctor", "App!View..ctor", "App!Root" };
accumulator.Add(41, 9, 10, recursive, true);
accumulator.Add(42, 8, 10, recursive, true);
accumulator.Add(42, 9, 9, recursive, true);
accumulator.Add(42, 9, 30, recursive, true);
Check(accumulator.SampleCount == 0, "PID/TID and half-open window filtering");
accumulator.Add(42, 9, 10, recursive, true);
accumulator.Add(42, 9, 11, recursive, true);
accumulator.Add(42, 9, 15, Array.Empty<string>(), false);
accumulator.Add(42, 9, 25, new[] { "Lib!Svg.Read", "App!View.Load" }, true);
Check(accumulator.SampleCount == 4, "Selected sample count includes missing stacks");
Check(accumulator.MissingStackSamples == 1, "Missing stacks explicit");
Check(accumulator.Groups[0].Samples == 3 && accumulator.Groups[1].Samples == 2, "Inclusive groups and case-insensitive OR");
Check(accumulator.GroupUnionSamples == 3 && accumulator.OverlapSamples == 3, "Overlap is explicit and union deduplicated");
Check(accumulator.Frames["App!View..ctor"].Samples == 2, "Recursion counts once per sample");
Check(accumulator.Frames["Lib!Gif.Decode"].LeafSamples == 2, "Leaf samples do not count callers");
Check(accumulator.Bins.Count == 3 && accumulator.Bins[0][0] == 2, "Timeline bins and boundary");
Check(accumulator.Bins[1][0] == 1 && accumulator.Bins[1].Skip(1).Sum() == 0, "Unattributed sample still contributes to timeline");
Check(accumulator.Examples[0].SequenceEqual(recursive.Reverse()), "Example root-to-leaf order");
using var report = JsonDocument.Parse(JsonSerializer.Serialize(accumulator.Report("input.etlx", "input.etlx", DateTime.UnixEpoch, 30)));
var root = report.RootElement;
Check(root.GetProperty("ok").GetBoolean(), "Nonempty scope produces evidence");
Check(root.GetProperty("groups")[0].GetProperty("percent").GetDouble() == 75, "Denominator includes missing stacks");
Check(root.GetProperty("groups")[0].GetProperty("sampleSpanMs").GetDouble() == 15, "Span is first-to-last, not samples or duration");
Check(root.GetProperty("groups")[3].GetProperty("firstSampleMs").ValueKind == JsonValueKind.Null, "Zero-match times stay null");
Check(root.GetProperty("topFrames").GetArrayLength() == 3, "Top limit enforced");
Check(root.GetProperty("measurementScope").GetProperty("unit").GetString().Contains("not milliseconds"), "Measurement caveat is machine-readable");
request.Tid = null;
var allThreads = new CpuBreakdown.Accumulator(request, 30);
allThreads.Add(42, 5, 11, new[] { "native!0x123" }, false);
allThreads.Add(42, 6, 11, Array.Empty<string>(), false);
Check(allThreads.Threads.Count == 2 && allThreads.UnresolvedOnlySamples == 1, "All-thread and unresolved-only coverage");
var empty = new CpuBreakdown.Accumulator(request, 30);
using var emptyReport = JsonDocument.Parse(JsonSerializer.Serialize(empty.Report("input.etlx", "input.etlx", DateTime.UnixEpoch, 30)));
Check(!emptyReport.RootElement.GetProperty("ok").GetBoolean(), "No CPU samples is not successful zero-cost evidence");
var wide = new CpuBreakdown.Accumulator(request, 10000000);
Check(wide.EffectiveBinMs >= (10000000 - request.StartMs) / 1000, "Timeline bounded to 1000 bins");
var deep = new CpuBreakdown.Accumulator(request, 30);
deep.Add(42, 9, 12, Enumerable.Repeat("App!View..ctor", 100).ToArray(), true);
Check(deep.Examples[0].Length == 64 && deep.ExampleTruncated[0], "Example depth cap is explicit");
Check(deep.Frames["App!View..ctor"].Samples == 1, "Deep recursion still counts once");
request.Groups = new[] { request.Groups[0], request.Groups[0] };
try { CpuBreakdown.Validate(request); throw new Exception("Duplicate names accepted"); }
catch (ArgumentException) { passed++; }
request.Groups = Array.Empty<CpuBreakdown.Group>();
request.StartMs = double.NaN;
try { CpuBreakdown.Validate(request); throw new Exception("NaN window accepted"); }
catch (ArgumentException) { passed++; }
Console.WriteLine($"CPU accumulator checks passed: {passed}");
