using System;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Net.Sockets;
using System.Threading;
using System.Windows.Forms;

namespace AtlasSoftWaterDesktop
{
    static class Program
    {
        private static Process serverProcess = null;
        private static string appDirectory = AppDomain.CurrentDomain.BaseDirectory;
        private static int port = 3000;
        private static string appUrl = "http://localhost:3000";

        [STAThread]
        static void Main()
        {
            Application.EnableVisualStyles();
            Application.SetCompatibleTextRenderingDefault(false);

            try
            {
                bool alreadyRunning = IsPortOpen("127.0.0.1", port, 300);
                if (!alreadyRunning)
                {
                    StartLocalServer();
                    WaitForServer(port, 12000);
                }

                LaunchStandaloneBrowserWindow(appUrl);
            }
            catch (Exception ex)
            {
                MessageBox.Show(
                    "Erreur lors du lancement d'Atlas Soft Water :\n" + ex.Message,
                    "Atlas Soft Water",
                    MessageBoxButtons.OK,
                    MessageBoxIcon.Error
                );
            }
        }

        private static void StartLocalServer()
        {
            ProcessStartInfo psi = new ProcessStartInfo();
            string tsxScript = Path.Combine(appDirectory, @"node_modules\tsx\dist\cli.mjs");
            string serverTs = Path.Combine(appDirectory, "server.ts");
            string viteScript = Path.Combine(appDirectory, @"node_modules\vite\bin\vite.js");
            if (File.Exists(tsxScript) && File.Exists(serverTs))
            {
                psi.FileName = "node.exe";
                psi.Arguments = String.Format("\"{0}\" \"{1}\"", tsxScript, serverTs);
            }
            else if (File.Exists(viteScript))
            {
                psi.FileName = "node.exe";
                psi.Arguments = String.Format("\"{0}\" --port=3000 --host=0.0.0.0", viteScript);
            }
            else
            {
                psi.FileName = "cmd.exe";
                psi.Arguments = "/c set \"PATHEXT=.COM;.EXE;.BAT;.CMD\" && npm.cmd run dev";
            }
            psi.WorkingDirectory = appDirectory;
            psi.UseShellExecute = false;
            psi.EnvironmentVariables["PATHEXT"] = ".COM;.EXE;.BAT;.CMD";
            psi.CreateNoWindow = true;
            psi.WindowStyle = ProcessWindowStyle.Hidden;

            serverProcess = Process.Start(psi);
        }

        private static bool IsPortOpen(string host, int targetPort, int timeoutMs)
        {
            try
            {
                using (TcpClient client = new TcpClient())
                {
                    IAsyncResult result = client.BeginConnect(host, targetPort, null, null);
                    bool success = result.AsyncWaitHandle.WaitOne(TimeSpan.FromMilliseconds(timeoutMs));
                    if (!success)
                    {
                        return false;
                    }
                    client.EndConnect(result);
                    return true;
                }
            }
            catch
            {
                return false;
            }
        }

        private static void WaitForServer(int targetPort, int maxWaitMs)
        {
            int waited = 0;
            int step = 300;
            while (waited < maxWaitMs)
            {
                if (IsPortOpen("127.0.0.1", targetPort, 250))
                {
                    return;
                }
                Thread.Sleep(step);
                waited += step;
            }
        }

        private static void LaunchStandaloneBrowserWindow(string url)
        {
            string edgePath1 = Path.Combine(
                Environment.GetFolderPath(Environment.SpecialFolder.ProgramFilesX86),
                @"Microsoft\Edge\Application\msedge.exe"
            );
            string edgePath2 = Path.Combine(
                Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles),
                @"Microsoft\Edge\Application\msedge.exe"
            );
            string chromePath1 = Path.Combine(
                Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles),
                @"Google\Chrome\Application\chrome.exe"
            );
            string chromePath2 = Path.Combine(
                Environment.GetFolderPath(Environment.SpecialFolder.ProgramFilesX86),
                @"Google\Chrome\Application\chrome.exe"
            );

            string args = String.Format("--app=\"{0}\" --start-maximized", url);

            if (File.Exists(edgePath1))
            {
                Process.Start(edgePath1, args);
                return;
            }
            if (File.Exists(edgePath2))
            {
                Process.Start(edgePath2, args);
                return;
            }
            if (File.Exists(chromePath1))
            {
                Process.Start(chromePath1, args);
                return;
            }
            if (File.Exists(chromePath2))
            {
                Process.Start(chromePath2, args);
                return;
            }

            try
            {
                Process.Start("msedge.exe", args);
                return;
            }
            catch
            {
            }

            Process.Start(url);
        }
    }
}
