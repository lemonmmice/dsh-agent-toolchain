// UiProbe — 经 Snoop 注入器打进目标桌面客户端进程内执行的只读诊断探针（net452，C#5）。
// 被注入方法签名必须匹配 GenericInjector 约定：public static int <Method>(string arg)。
// 载荷文件（UTF-8）格式：
//   第0行 = 结果文件路径
//   第1行 = 动作：echo | dump-tree | run-script
//   第2行 = 动作参数（dump-tree: 最大深度；run-script: 脚本 .ps1 路径）
// 输出全部写入结果文件（UTF-8），关键信息同时 Console.WriteLine（配合 --attachConsoleToParent）。
using System;
using System.Collections;
using System.Collections.Generic;
using System.Collections.ObjectModel;
using System.Diagnostics;
using System.Globalization;
using System.IO;
using System.Net;
using System.Management.Automation;
using System.Management.Automation.Host;
using System.Management.Automation.Runspaces;
using System.Reflection;
using System.Security;
using System.Text;
using System.Threading;
using System.Windows;
using System.Windows.Automation;
using System.Windows.Media;

namespace UiProbe
{
    public static class Entry
    {
        private static string s_log;

        private static void Log(string msg)
        {
            try { if (s_log != null) File.AppendAllText(s_log, msg + Environment.NewLine, Encoding.UTF8); }
            catch { }
            try { Console.WriteLine(msg); }
            catch { }
        }

        /// <summary>GenericInjector 调用的入口（方法名/参数签名固定）。</summary>
        public static int Run(string payloadFile)
        {
            s_log = Path.Combine(Path.GetTempPath(), "uiprobe.log");
            try
            {
                HookAssemblyResolve();
                string[] lines = File.ReadAllLines(payloadFile, Encoding.UTF8);
                string resultPath = lines.Length > 0 ? lines[0] : Path.Combine(Path.GetTempPath(), "uiprobe-result.txt");
                string action = lines.Length > 1 ? lines[1] : "echo";
                string arg1 = lines.Length > 2 ? lines[2] : "";

                if (action == "echo") Echo(resultPath);
                else if (action == "dump-tree") DumpTree(resultPath, arg1);
                else if (action == "run-script") RunScript(resultPath, arg1);
                else if (action == "hook-net") HookNet(resultPath, arg1);
                else if (action == "unhook-net") UnhookNet(resultPath);
                else File.WriteAllText(resultPath, "UNKNOWN_ACTION " + action, Encoding.UTF8);
                return 0;
            }
            catch (Exception ex)
            {
                Log("PROBE_ERR " + ex);
                try { File.WriteAllText(Path.Combine(Path.GetTempPath(), "uiprobe-result.txt"), "PROBE_ERR " + ex, Encoding.UTF8); }
                catch { }
                return 1;
            }
        }

        private static void HookAssemblyResolve()
        {
            try
            {
                AppDomain.CurrentDomain.AssemblyResolve += delegate(object s, ResolveEventArgs a)
                {
                    try
                    {
                        string dir = Path.GetDirectoryName(Assembly.GetExecutingAssembly().Location);
                        string name = new AssemblyName(a.Name).Name + ".dll";
                        string p = Path.Combine(dir, name);
                        return File.Exists(p) ? Assembly.LoadFrom(p) : null;
                    }
                    catch { return null; }
                };
            }
            catch { }
        }

        // Application.Current 跨线程会抛异常；失败时用反射取私有静态字段 _appInstance 绕过线程校验。
        private static Application GetApplication()
        {
            try { return Application.Current; }
            catch { }
            try
            {
                FieldInfo f = typeof(Application).GetField("_appInstance", BindingFlags.Static | BindingFlags.NonPublic);
                if (f != null) return (Application)f.GetValue(null);
            }
            catch { }
            return null;
        }

        private static void Echo(string outFile)
        {
            StringBuilder sb = new StringBuilder();
            Thread t = Thread.CurrentThread;
            sb.AppendLine("thread=" + t.ManagedThreadId);
            sb.AppendLine("apartment=" + t.GetApartmentState());
            Application app = null;
            try { app = Application.Current; sb.AppendLine("app.current=ok"); }
            catch (Exception ex) { sb.AppendLine("app.current=THROWS " + ex.GetType().Name); }
            if (app == null) { app = GetApplication(); if (app != null) sb.AppendLine("app.current=via-reflection"); }
            if (app != null)
            {
                sb.AppendLine("dispatcherThread=" + app.Dispatcher.Thread.ManagedThreadId);
                try
                {
                    app.Dispatcher.Invoke(new Action(delegate()
                    {
                        sb.AppendLine("windows=" + app.Windows.Count);
                        foreach (Window w in app.Windows) sb.AppendLine("  win: " + w.Title + " (" + w.GetType().FullName + ")");
                    }));
                }
                catch (Exception ex) { sb.AppendLine("WIN_ERR " + ex.GetType().Name + ": " + ex.Message); }
            }
            else sb.AppendLine("app=null");
            sb.AppendLine("probeAssembly=" + Assembly.GetExecutingAssembly().Location);
            File.WriteAllText(outFile, sb.ToString(), Encoding.UTF8);
        }

        private static void DumpTree(string outFile, string maxDepthArg)
        {
            int maxDepth = 8;
            int.TryParse(maxDepthArg, out maxDepth);
            StringBuilder sb = new StringBuilder();
            int count = 0;
            const int cap = 4000;
            Application app = GetApplication();
            if (app == null) { File.WriteAllText(outFile, "NO_APPLICATION", Encoding.UTF8); return; }
            app.Dispatcher.Invoke(new Action(delegate()
            {
                try
                {
                    foreach (Window w in app.Windows)
                    {
                        if (count >= cap) break;
                        Walk(w, 0, maxDepth, sb, ref count, cap);
                    }
                }
                catch (Exception ex) { sb.AppendLine("DUMP_ERR " + ex.GetType().Name + ": " + ex.Message); }
            }));
            File.WriteAllText(outFile, sb.ToString(), Encoding.UTF8);
        }

        private static void Walk(DependencyObject d, int depth, int maxDepth, StringBuilder sb, ref int count, int cap)
        {
            if (count >= cap || depth > maxDepth) return;
            try
            {
                string indent = new string(' ', depth * 2);
                string type = d.GetType().FullName;
                string name = "";
                string aid = "";
                string dc = "";
                try
                {
                    FrameworkElement fe = d as FrameworkElement;
                    if (fe != null) { name = fe.Name; aid = AutomationProperties.GetAutomationId(fe); if (fe.DataContext != null) dc = fe.DataContext.GetType().FullName; }
                    else
                    {
                        FrameworkContentElement fce = d as FrameworkContentElement;
                        if (fce != null) name = fce.Name;
                    }
                }
                catch { }
                sb.AppendLine(indent + type + "|name=" + name + "|aid=" + aid + "|dc=" + dc);
                count++;
                if (depth >= maxDepth) return;
                int n = VisualTreeHelper.GetChildrenCount(d);
                for (int i = 0; i < n && count < cap; i++)
                    Walk(VisualTreeHelper.GetChild(d, i), depth + 1, maxDepth, sb, ref count, cap);
            }
            catch { }
        }

        private static void RunScript(string outFile, string scriptPath)
        {
            if (!File.Exists(scriptPath))
            {
                File.WriteAllText(outFile, "SCRIPT_NOT_FOUND " + scriptPath, Encoding.UTF8);
                return;
            }
            StringBuilder capture = new StringBuilder();
            CapturePSHost host = new CapturePSHost(capture);
            Runspace rs = RunspaceFactory.CreateRunspace(host, InitialSessionState.CreateDefault());
            rs.Open();
            try
            {
                // UI 线程上没有运行空间；把当前 Runspace 挂到 UI 线程 TLS，
                // 脚本里 Dispatcher.Invoke([Action]{...}) 的脚本块才能在 UI 线程执行。
                try
                {
                    Application app = GetApplication();
                    if (app != null)
                    {
                        app.Dispatcher.Invoke(new Action(delegate() { Runspace.DefaultRunspace = rs; }));
                    }
                }
                catch { }
                using (PowerShell ps = PowerShell.Create())
                {
                    ps.Runspace = rs;
                    string script = File.ReadAllText(scriptPath, Encoding.UTF8);
                    ps.AddScript(script);
                    try
                    {
                        Collection<PSObject> output = ps.Invoke();
                        foreach (PSObject o in output) capture.AppendLine(o == null ? "" : o.ToString());
                    }
                    catch (Exception ex) { capture.AppendLine("SCRIPT_ERR " + ex); }
                    foreach (ErrorRecord e in ps.Streams.Error) capture.AppendLine("ERROR: " + e);
                }
            }
            finally { rs.Close(); }
            File.WriteAllText(outFile, capture.ToString(), Encoding.UTF8);
        }

        // ============ 网络抓包动作 ============

        /// <summary>从 WebRequest 内部前缀表反射取出当前注册的创建器。</summary>
        /// <param name="scheme">"https:" / "http:"（不带 //，与原表键一致）</param>
        private static IWebRequestCreate GetOriginalCreator(string scheme)
        {
            try
            {
                FieldInfo f = typeof(WebRequest).GetField("s_PrefixList", BindingFlags.Static | BindingFlags.NonPublic);
                NetCapture.Write("DBG s_PrefixList field=" + (f != null));
                if (f == null) return null;
                object raw = f.GetValue(null);
                NetCapture.Write("DBG raw type=" + (raw == null ? "null" : raw.GetType().FullName));
                ArrayList list = raw as ArrayList;
                if (list == null) return null;
                NetCapture.Write("DBG list count=" + list.Count);
                foreach (object item in list)
                {
                    Type t = item.GetType();
                    FieldInfo pf = t.GetField("Prefix", BindingFlags.Instance | BindingFlags.Public | BindingFlags.NonPublic);
                    FieldInfo cf = t.GetField("creator", BindingFlags.Instance | BindingFlags.Public | BindingFlags.NonPublic);
                    if (pf == null || cf == null) { NetCapture.Write("DBG fields missing for " + t.FullName); continue; }
                    string prefix = pf.GetValue(item) as string;
                    IWebRequestCreate creator = cf.GetValue(item) as IWebRequestCreate;
                    if (creator == null)
                    {
                        // http: 等条目 creator 字段为空，创建器以 Type 形式存在 creatorType 字段（惰性实例化）
                        FieldInfo ct = t.GetField("creatorType", BindingFlags.Instance | BindingFlags.Public | BindingFlags.NonPublic);
                        if (ct != null)
                        {
                            Type creatorType = ct.GetValue(item) as Type;
                            if (creatorType != null)
                            {
                                try { creator = Activator.CreateInstance(creatorType, true) as IWebRequestCreate; }
                                catch (Exception ex) { NetCapture.Write("DBG creatorType instantiate EX: " + ex.Message); }
                            }
                        }
                    }
                    NetCapture.Write("DBG prefix=" + prefix + " creator=" + (creator == null ? "null" : creator.GetType().FullName));
                    if (prefix == scheme && creator != null) return creator;
                }
                return null;
            }
            catch (Exception ex) { NetCapture.Write("DBG GetOriginalCreator EX: " + ex); return null; }
        }

        private static void HookNet(string outFile, string logPath)
        {
            if (string.IsNullOrEmpty(logPath)) logPath = Path.Combine(Path.GetTempPath(), "uiprobe-net.log");
            NetCapture.LogPath = logPath;
            File.WriteAllText(logPath, "=== UIPROBE NET CAPTURE START " + DateTime.Now + " ===\r\n", Encoding.UTF8);
            StringBuilder status = new StringBuilder();
            // 1. 开启 System.Net TraceSource（URL/头/状态码 全量）
            try
            {
                string[] names = new string[] { "System.Net", "System.Net.Sockets", "System.Net.Cache", "System.Net.HttpListener" };
                foreach (string n in names)
                {
                    TraceSource ts = new TraceSource(n);
                    ts.Switch.Level = SourceLevels.Verbose;
                    ts.Listeners.Clear();
                    TextWriterTraceListener l = new TextWriterTraceListener(logPath);
                    ts.Listeners.Add(l);
                }
                status.AppendLine("trace=enabled");
            }
            catch (Exception ex) { status.AppendLine("trace=FAILED " + ex.Message); }
            // 2. 不再注册 WebRequest 前缀工厂：
            //    包装类会破坏客户端代码的 (HttpWebRequest) 类型强转（登录等流程直接失败）。
            //    抓接口走 scripts\net-trace.ps1（对 exe.config 注入 system.diagnostics + 重启客户端）。
            status.AppendLine("prefixFactory=SKIPPED（用 net-trace.ps1 配置注入替代，勿再启用本工厂）");
            status.AppendLine("logPath=" + logPath);
            status.AppendLine("NOTE: 卸载需重启客户端（前缀工厂为进程级注册）");
            File.WriteAllText(outFile, status.ToString(), Encoding.UTF8);
        }

        private static void UnhookNet(string outFile)
        {
            StringBuilder status = new StringBuilder();
            try
            {
                string[] names = new string[] { "System.Net", "System.Net.Sockets", "System.Net.Cache", "System.Net.HttpListener" };
                foreach (string n in names)
                {
                    TraceSource ts = new TraceSource(n);
                    ts.Switch.Level = SourceLevels.Off;
                }
                status.AppendLine("trace=disabled");
            }
            catch (Exception ex) { status.AppendLine("trace=FAILED " + ex.Message); }
            status.AppendLine("prefixFactory: 进程级注册无法卸载，重启客户端即恢复");
            File.WriteAllText(outFile, status.ToString(), Encoding.UTF8);
        }
    }

    internal sealed class CapturePSHost : PSHost
    {
        private readonly Guid id = Guid.NewGuid();
        private readonly StringBuilder buf;
        private PSHostUserInterface ui;
        public CapturePSHost(StringBuilder b) { buf = b; }
        public override string Name { get { return "UiProbeHost"; } }
        public override Version Version { get { return new Version(1, 0, 0, 0); } }
        public override Guid InstanceId { get { return id; } }
        public override CultureInfo CurrentCulture { get { return Thread.CurrentThread.CurrentCulture; } }
        public override CultureInfo CurrentUICulture { get { return Thread.CurrentThread.CurrentUICulture; } }
        public override PSHostUserInterface UI { get { if (ui == null) ui = new CaptureUI(buf); return ui; } }
        public override PSObject PrivateData { get { return new PSObject(new Hashtable()); } }
        public override void SetShouldExit(int exitCode) { }
        public override void EnterNestedPrompt() { }
        public override void ExitNestedPrompt() { }
        public override void NotifyBeginApplication() { }
        public override void NotifyEndApplication() { }
    }

    internal sealed class CaptureUI : PSHostUserInterface
    {
        private readonly StringBuilder buf;
        private PSHostRawUserInterface raw;
        public CaptureUI(StringBuilder b) { buf = b; }
        public override PSHostRawUserInterface RawUI { get { if (raw == null) raw = new CaptureRawUI(); return raw; } }
        public override void Write(string value) { buf.Append(value); }
        public override void Write(ConsoleColor fg, ConsoleColor bg, string value) { buf.Append(value); }
        public override void WriteLine() { buf.AppendLine(); }
        public override void WriteLine(string value) { buf.AppendLine(value); }
        public override void WriteLine(ConsoleColor fg, ConsoleColor bg, string value) { buf.AppendLine(value); }
        public override void WriteDebugLine(string value) { buf.AppendLine("DEBUG: " + value); }
        public override void WriteErrorLine(string value) { buf.AppendLine("ERROR: " + value); }
        public override void WriteVerboseLine(string value) { buf.AppendLine("VERBOSE: " + value); }
        public override void WriteWarningLine(string value) { buf.AppendLine("WARNING: " + value); }
        public override void WriteProgress(long sourceId, ProgressRecord record) { }
        public override string ReadLine() { return ""; }
        public override SecureString ReadLineAsSecureString() { return new SecureString(); }
        public override Dictionary<string, PSObject> Prompt(string caption, string message, Collection<FieldDescription> descriptions) { return null; }
        public override PSCredential PromptForCredential(string caption, string message, string userName, string targetName) { return null; }
        public override PSCredential PromptForCredential(string caption, string message, string userName, string targetName, PSCredentialTypes allowedCredentialTypes, PSCredentialUIOptions options) { return null; }
        public override int PromptForChoice(string caption, string message, Collection<ChoiceDescription> choices, int defaultChoice) { return defaultChoice; }
    }

    internal sealed class CaptureRawUI : PSHostRawUserInterface
    {
        public override ConsoleColor BackgroundColor { get { return ConsoleColor.Black; } set { } }
        public override ConsoleColor ForegroundColor { get { return ConsoleColor.White; } set { } }
        public override int CursorSize { get { return 25; } set { } }
        public override bool KeyAvailable { get { return false; } }
        public override string WindowTitle { get { return "UiProbe"; } set { } }
        public override System.Management.Automation.Host.Size BufferSize { get { return new System.Management.Automation.Host.Size(120, 50); } set { } }
        public override System.Management.Automation.Host.Coordinates CursorPosition { get { return new System.Management.Automation.Host.Coordinates(0, 0); } set { } }
        public override System.Management.Automation.Host.Size MaxPhysicalWindowSize { get { return new System.Management.Automation.Host.Size(240, 80); } }
        public override System.Management.Automation.Host.Size MaxWindowSize { get { return new System.Management.Automation.Host.Size(120, 50); } }
        public override System.Management.Automation.Host.Coordinates WindowPosition { get { return new System.Management.Automation.Host.Coordinates(0, 0); } set { } }
        public override System.Management.Automation.Host.Size WindowSize { get { return new System.Management.Automation.Host.Size(120, 50); } set { } }
        public override void FlushInputBuffer() { }
        public override System.Management.Automation.Host.BufferCell[,] GetBufferContents(System.Management.Automation.Host.Rectangle r) { return new BufferCell[0, 0]; }
        public override int LengthInBufferCells(char c) { return 1; }
        public override int LengthInBufferCells(string s) { return s == null ? 0 : s.Length; }
        public override System.Management.Automation.Host.KeyInfo ReadKey(System.Management.Automation.Host.ReadKeyOptions options) { return new KeyInfo(); }
        public override void ScrollBufferContents(System.Management.Automation.Host.Rectangle source, System.Management.Automation.Host.Coordinates destination, System.Management.Automation.Host.Rectangle clip, System.Management.Automation.Host.BufferCell fill) { }
        public override void SetBufferContents(System.Management.Automation.Host.Coordinates origin, System.Management.Automation.Host.BufferCell[,] contents) { }
        public override void SetBufferContents(System.Management.Automation.Host.Rectangle rect, System.Management.Automation.Host.BufferCell fill) { }
    }
    // ============ 网络抓包（hook-net） ============

    internal static class NetCapture
    {
        public static string LogPath;
        private static readonly object s_lock = new object();

        public static void Write(string msg)
        {
            try
            {
                lock (s_lock)
                {
                    if (LogPath != null) File.AppendAllText(LogPath, msg + Environment.NewLine, Encoding.UTF8);
                }
            }
            catch { }
        }

        public static bool IsPrintable(byte[] data)
        {
            if (data == null || data.Length == 0) return true;
            int nonPrintable = 0;
            for (int i = 0; i < data.Length && i < 512; i++)
            {
                byte b = data[i];
                if (b < 0x09 || (b > 0x0D && b < 0x20)) nonPrintable++;
            }
            return nonPrintable * 10 < data.Length;
        }
    }

    /// <summary>替代 WebRequest.Create 的工厂：把新建的 HttpWebRequest 包一层做请求体捕获。</summary>
    internal sealed class CaptureFactory : IWebRequestCreate
    {
        private readonly IWebRequestCreate original;
        public CaptureFactory(IWebRequestCreate original) { this.original = original; }
        public WebRequest Create(Uri uri)
        {
            try
            {
                if (original == null) { NetCapture.Write("NET_FACTORY_ERR original creator is null"); return null; }
                WebRequest inner = original.Create(uri);
                if (inner is HttpWebRequest) return new CaptureWebRequest((HttpWebRequest)inner);
                return inner;
            }
            catch (Exception ex)
            {
                NetCapture.Write("NET_FACTORY_ERR " + ex);
                return null;
            }
        }
    }

    internal sealed class CaptureWebRequest : WebRequest
    {
        private readonly HttpWebRequest inner;
        public CaptureWebRequest(HttpWebRequest inner) { this.inner = inner; }
        public HttpWebRequest Inner { get { return inner; } }

        public override Uri RequestUri { get { return inner.RequestUri; } }
        public override string Method { get { return inner.Method; } set { inner.Method = value; } }
        public override string ConnectionGroupName { get { return inner.ConnectionGroupName; } set { inner.ConnectionGroupName = value; } }
        public override long ContentLength { get { return inner.ContentLength; } set { inner.ContentLength = value; } }
        public override string ContentType { get { return inner.ContentType; } set { inner.ContentType = value; } }
        public override WebHeaderCollection Headers { get { return inner.Headers; } set { inner.Headers = value; } }
        public override ICredentials Credentials { get { return inner.Credentials; } set { inner.Credentials = value; } }
        public override bool PreAuthenticate { get { return inner.PreAuthenticate; } set { inner.PreAuthenticate = value; } }
        public override int Timeout { get { return inner.Timeout; } set { inner.Timeout = value; } }
        public override IWebProxy Proxy { get { return inner.Proxy; } set { inner.Proxy = value; } }
        public override bool UseDefaultCredentials { get { return inner.UseDefaultCredentials; } set { inner.UseDefaultCredentials = value; } }

        private static string Describe(WebHeaderCollection h)
        {
            try
            {
                StringBuilder sb = new StringBuilder();
                foreach (string k in h.AllKeys)
                {
                    if (k == null) continue;
                    sb.Append("  ").Append(k).Append(": ").Append(h[k]).AppendLine();
                }
                return sb.ToString();
            }
            catch { return "  (headers unreadable)"; }
        }

        private void LogRequestHead()
        {
            try
            {
                NetCapture.Write("=== REQUEST " + DateTime.Now.ToString("yyyy-MM-dd HH:mm:ss.fff") + " ===");
                NetCapture.Write(inner.Method + " " + inner.RequestUri);
                NetCapture.Write(Describe(inner.Headers));
            }
            catch (Exception ex) { NetCapture.Write("REQ_HEAD_ERR " + ex.Message); }
        }

        private void LogResponseHead(WebResponse resp)
        {
            try
            {
                NetCapture.Write("=== RESPONSE " + DateTime.Now.ToString("yyyy-MM-dd HH:mm:ss.fff") + " ===");
                HttpWebResponse hr = resp as HttpWebResponse;
                if (hr != null)
                {
                    NetCapture.Write("STATUS " + (int)hr.StatusCode + " " + hr.StatusCode);
                    NetCapture.Write(Describe(hr.Headers));
                }
            }
            catch (Exception ex) { NetCapture.Write("RESP_HEAD_ERR " + ex.Message); }
        }

        public override void Abort() { inner.Abort(); }

        public override Stream GetRequestStream()
        {
            LogRequestHead();
            return new TeeStream(inner.GetRequestStream(), true, "REQ_BODY");
        }

        public override IAsyncResult BeginGetRequestStream(AsyncCallback callback, object state)
        {
            LogRequestHead();
            return new WrappedAsyncResult(inner.BeginGetRequestStream(callback, state));
        }

        public override Stream EndGetRequestStream(IAsyncResult asyncResult)
        {
            return new TeeStream(inner.EndGetRequestStream(((WrappedAsyncResult)asyncResult).Inner), true, "REQ_BODY");
        }

        public override WebResponse GetResponse()
        {
            LogRequestHead();
            WebResponse resp = inner.GetResponse();
            LogResponseHead(resp);
            return resp;
        }

        public override IAsyncResult BeginGetResponse(AsyncCallback callback, object state)
        {
            LogRequestHead();
            return new WrappedAsyncResult(inner.BeginGetResponse(callback, state));
        }

        public override WebResponse EndGetResponse(IAsyncResult asyncResult)
        {
            WebResponse resp = inner.EndGetResponse(((WrappedAsyncResult)asyncResult).Inner);
            LogResponseHead(resp);
            return resp;
        }
    }

    internal sealed class WrappedAsyncResult : IAsyncResult
    {
        private readonly IAsyncResult inner;
        public WrappedAsyncResult(IAsyncResult inner) { this.inner = inner; }
        public IAsyncResult Inner { get { return inner; } }
        public object AsyncState { get { return inner.AsyncState; } }
        public WaitHandle AsyncWaitHandle { get { return inner.AsyncWaitHandle; } }
        public bool CompletedSynchronously { get { return inner.CompletedSynchronously; } }
        public bool IsCompleted { get { return inner.IsCompleted; } }
    }

    /// <summary>把写入/读出的字节流同时抄一份进抓包日志。</summary>
    internal sealed class TeeStream : Stream
    {
        private readonly Stream inner;
        private readonly bool teeWrites;
        private readonly string tag;
        public TeeStream(Stream inner, bool teeWrites, string tag) { this.inner = inner; this.teeWrites = teeWrites; this.tag = tag; }
        public override bool CanRead { get { return inner.CanRead; } }
        public override bool CanSeek { get { return inner.CanSeek; } }
        public override bool CanWrite { get { return inner.CanWrite; } }
        public override long Length { get { return inner.Length; } }
        public override long Position { get { return inner.Position; } set { inner.Position = value; } }
        public override void Flush() { inner.Flush(); }
        public override int Read(byte[] buffer, int offset, int count)
        {
            int n = inner.Read(buffer, offset, count);
            if (n > 0 && !teeWrites) { byte[] copy = new byte[n]; Array.Copy(buffer, offset, copy, 0, n); LogChunk(copy); }
            return n;
        }
        public override void Write(byte[] buffer, int offset, int count)
        {
            if (teeWrites) { byte[] copy = new byte[count]; Array.Copy(buffer, offset, copy, 0, count); LogChunk(copy); }
            inner.Write(buffer, offset, count);
        }
        public override long Seek(long offset, SeekOrigin origin) { return inner.Seek(offset, origin); }
        public override void SetLength(long value) { inner.SetLength(value); }
        private void LogChunk(byte[] data)
        {
            try
            {
                NetCapture.Write(tag + " CHUNK (" + data.Length + " bytes): " +
                    (NetCapture.IsPrintable(data) ? Encoding.UTF8.GetString(data) : Convert.ToBase64String(data)));
            }
            catch { }
        }
    }

}