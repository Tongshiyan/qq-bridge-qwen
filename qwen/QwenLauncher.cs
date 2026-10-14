// ============================================================
//  Qwen control-panel launcher (compiled by install.ps1 to
//  QwenConsoleLauncher.exe, then renamed to "Qwen控制台.exe").
//
//  Starts the PowerShell + WinForms UI without a console window.
//
//  PATH-INDEPENDENT: the panel script is resolved next to THIS exe,
//  so the whole folder can be copied anywhere. If the panel is not
//  found next to the exe, the fallbacks below are tried in order,
//  and every failure is written to launcher-error.log next to the
//  exe (a winexe has no console to print to).
//
//  Build (install.ps1 does this automatically):
//    csc.exe /nologo /target:winexe /out:QwenConsoleLauncher.exe ^
//        /win32icon:qwen.ico /r:System.Windows.Forms.dll QwenLauncher.cs
//
//  NOTE: keep this file ASCII-only. csc.exe reads sources with the
//  system ANSI code page (936 on zh-CN Windows); a UTF-8 file without
//  a BOM can be mis-decoded and break parsing.
// ============================================================
using System;
using System.Diagnostics;
using System.IO;
using System.Text;
using System.Windows.Forms;

class QwenConsoleLauncher
{
    static string ExeDir()
    {
        try { return Path.GetDirectoryName(Application.ExecutablePath); }
        catch { return null; }
    }

    static string[] CandidateScripts()
    {
        string dir = ExeDir();
        string home = Environment.GetFolderPath(Environment.SpecialFolder.UserProfile);
        return new string[]
        {
            dir == null ? null : Path.Combine(dir, "QwenControlPanel.ps1"),
            Path.Combine(home, "Desktop", "qwen", "QwenControlPanel.ps1"),
            Path.Combine(home, "qwen", "QwenControlPanel.ps1"),
            @"C:\qwen\QwenControlPanel.ps1"
        };
    }

    static void LogFailure(string message)
    {
        try
        {
            string dir = ExeDir();
            if (dir == null) return;
            File.AppendAllText(
                Path.Combine(dir, "launcher-error.log"),
                DateTime.Now.ToString("yyyy-MM-dd HH:mm:ss") + "  " + message + Environment.NewLine,
                new UTF8Encoding(false));
        }
        catch { }
    }

    [STAThread]
    static void Main()
    {
        string script = null;
        foreach (string c in CandidateScripts())
        {
            if (c != null && File.Exists(c)) { script = c; break; }
        }

        if (script == null)
        {
            string tried = string.Join("\n", Array.FindAll(CandidateScripts(), c => c != null));
            string msg = "Control panel script not found. Tried:\n" + tried;
            LogFailure(msg);
            MessageBox.Show(msg, "Qwen Console", MessageBoxButtons.OK, MessageBoxIcon.Error);
            return;
        }

        ProcessStartInfo psi = new ProcessStartInfo();
        psi.FileName  = "powershell.exe";
        psi.Arguments = "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File \"" + script + "\"";
        psi.UseShellExecute = false;
        psi.CreateNoWindow  = true;

        try
        {
            Process.Start(psi);
        }
        catch (Exception ex)
        {
            string msg = "Failed to start the control panel:\n" + ex.Message;
            LogFailure(msg + "  (script=" + script + ")");
            MessageBox.Show(msg, "Qwen Console", MessageBoxButtons.OK, MessageBoxIcon.Error);
        }
    }
}
