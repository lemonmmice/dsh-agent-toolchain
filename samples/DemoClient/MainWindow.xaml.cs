using System;
using System.Net.Http;
using System.Threading;
using System.Windows;

namespace DemoClient
{
    public partial class MainWindow : Window
    {
        // One shared client: creating a new HttpClient per request is the classic
        // socket-exhaustion bug and this window is also used as a proxy-demo target.
        private static readonly HttpClient Http = new HttpClient { Timeout = TimeSpan.FromSeconds(5) };

        public MainWindow()
        {
            InitializeComponent();
        }

        private void OnGreet(object sender, RoutedEventArgs e)
        {
            Result.Text = "Hello, " + Input.Text + " — clicked at " + DateTime.Now.ToString("HH:mm:ss");
        }

        private void OnFreeze(object sender, RoutedEventArgs e)
        {
            // Blocks the UI thread on purpose: this is the stutter the perf tools
            // are supposed to catch, so it must be real and repeatable.
            Thread.Sleep(1500);
            Result.Text = "Froze the UI for 1500 ms at " + DateTime.Now.ToString("HH:mm:ss");
        }

        private async void OnPing(object sender, RoutedEventArgs e)
        {
            // async void is correct for a WPF event handler only because every path
            // below is inside try/catch — nothing escapes to the dispatcher.
            var url = PingUrl.Text;
            try
            {
                using (var response = await Http.GetAsync(url).ConfigureAwait(true))
                {
                    var body = await response.Content.ReadAsStringAsync().ConfigureAwait(true);
                    if (body.Length > 300) body = body.Substring(0, 300) + "…";
                    HttpResult.Text = "HTTP " + (int)response.StatusCode + " from " + url + Environment.NewLine + body;
                }
            }
            catch (Exception ex)
            {
                HttpResult.Text = "request failed: " + ex.GetType().Name + ": " + ex.Message;
            }
        }
    }
}
