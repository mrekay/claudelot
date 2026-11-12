// VoxStorm console mirror.
// Attaches to the console of a process started outside VoxStorm (a Claude Code session
// running in cmd, PowerShell or Windows Terminal), streams its visible screen and types
// keys into it. Compiled on first use with the csc.exe that ships with Windows.
//
// stdout, one line per change:  F <cols> <rows> <cursorX> <cursorY> <cursorVisible 0|1> <base64 utf-8 VT text>
//                               E <win32 error code>   (could not attach)
// stdin, one line per batch:    I <vk> <char> <ctrlState> [<vk> <char> <ctrlState> ...]
using System;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

static class Mirror
{
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool FreeConsole();
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool AttachConsole(uint pid);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool SetConsoleCtrlHandler(IntPtr handler, bool add);
    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    static extern IntPtr CreateFileW(string name, uint access, uint share, IntPtr sa, uint disposition, uint flags, IntPtr template);
    [DllImport("kernel32.dll", SetLastError = true)] static extern IntPtr OpenProcess(uint access, bool inherit, uint pid);
    [DllImport("kernel32.dll", SetLastError = true)] static extern uint WaitForSingleObject(IntPtr h, uint ms);

    [StructLayout(LayoutKind.Sequential)] struct COORD { public short X, Y; public COORD(short x, short y) { X = x; Y = y; } }
    [StructLayout(LayoutKind.Sequential)] struct SMALL_RECT { public short Left, Top, Right, Bottom; }
    [StructLayout(LayoutKind.Sequential)] struct CSBI { public COORD Size, Cursor; public ushort Attr; public SMALL_RECT Window; public COORD MaxWindow; }
    [StructLayout(LayoutKind.Sequential)] struct CURSOR_INFO { public uint Size; public int Visible; }
    [StructLayout(LayoutKind.Explicit, CharSet = CharSet.Unicode)] struct CHAR_INFO { [FieldOffset(0)] public char Ch; [FieldOffset(2)] public ushort Attr; }
    [StructLayout(LayoutKind.Explicit, CharSet = CharSet.Unicode)]
    struct INPUT_RECORD
    {
        [FieldOffset(0)] public ushort EventType;
        [FieldOffset(4)] public int KeyDown;
        [FieldOffset(8)] public ushort Repeat;
        [FieldOffset(10)] public ushort Vk;
        [FieldOffset(12)] public ushort Scan;
        [FieldOffset(14)] public char Ch;
        [FieldOffset(16)] public uint Ctrl;
    }

    [DllImport("kernel32.dll", SetLastError = true)] static extern bool GetConsoleScreenBufferInfo(IntPtr h, out CSBI info);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool GetConsoleCursorInfo(IntPtr h, out CURSOR_INFO info);
    [DllImport("kernel32.dll", SetLastError = true, EntryPoint = "ReadConsoleOutputW")]
    static extern bool ReadConsoleOutput(IntPtr h, [Out] CHAR_INFO[] buf, COORD size, COORD at, ref SMALL_RECT region);
    [DllImport("kernel32.dll", SetLastError = true, EntryPoint = "WriteConsoleInputW")]
    static extern bool WriteConsoleInput(IntPtr h, INPUT_RECORD[] recs, uint n, out uint written);
    [DllImport("user32.dll")] static extern uint MapVirtualKeyW(uint code, uint type);

    const uint GENERIC_READ = 0x80000000, GENERIC_WRITE = 0x40000000, SHARE_RW = 3, OPEN_EXISTING = 3;
    static readonly int[] WinToAnsi = { 0, 4, 2, 6, 1, 5, 3, 7 };
    static Stream stdout;
    static readonly object outLock = new object();

    static void Emit(string line)
    {
        var b = Encoding.UTF8.GetBytes(line + "\n");
        lock (outLock) { try { stdout.Write(b, 0, b.Length); stdout.Flush(); } catch { Environment.Exit(0); } }
    }

    static int Main(string[] args)
    {
        uint pid;
        if (args.Length < 1 || !uint.TryParse(args[0], out pid)) return 2;
        // grab the pipes from VoxStorm before switching consoles
        stdout = Console.OpenStandardOutput();
        var stdin = Console.OpenStandardInput();
        FreeConsole();
        if (!AttachConsole(pid)) { Emit("E " + Marshal.GetLastWin32Error()); return 1; }
        SetConsoleCtrlHandler(IntPtr.Zero, true); // a Ctrl+C typed into the session must not stop us
        IntPtr outH = CreateFileW("CONOUT$", GENERIC_READ | GENERIC_WRITE, SHARE_RW, IntPtr.Zero, OPEN_EXISTING, 0, IntPtr.Zero);
        IntPtr inH = CreateFileW("CONIN$", GENERIC_READ | GENERIC_WRITE, SHARE_RW, IntPtr.Zero, OPEN_EXISTING, 0, IntPtr.Zero);
        IntPtr proc = OpenProcess(0x00100000 /* SYNCHRONIZE */, false, pid);

        var reader = new Thread(() => ReadInput(stdin, inH)) { IsBackground = true };
        reader.Start();

        string last = null;
        int idle = 0;
        while (true)
        {
            if (proc != IntPtr.Zero && WaitForSingleObject(proc, 0) == 0) return 0; // session ended
            string frame = ReadFrame(outH);
            if (frame == null) { if (++idle > 40) return 0; }
            else { idle = 0; if (frame != last) { Emit(frame); last = frame; } }
            Thread.Sleep(70);
        }
    }

    static string ReadFrame(IntPtr h)
    {
        CSBI info;
        if (!GetConsoleScreenBufferInfo(h, out info)) return null;
        int cols = info.Window.Right - info.Window.Left + 1, rows = info.Window.Bottom - info.Window.Top + 1;
        if (cols <= 0 || rows <= 0) return null;
        var cells = new CHAR_INFO[cols * rows];
        // read in strips; one large call can fail on very wide consoles
        int strip = Math.Max(1, 12000 / cols);
        for (int y = 0; y < rows; y += strip)
        {
            int n = Math.Min(strip, rows - y);
            var part = new CHAR_INFO[cols * n];
            var region = new SMALL_RECT { Left = info.Window.Left, Top = (short)(info.Window.Top + y), Right = info.Window.Right, Bottom = (short)(info.Window.Top + y + n - 1) };
            if (!ReadConsoleOutput(h, part, new COORD((short)cols, (short)n), new COORD(0, 0), ref region)) return null;
            Array.Copy(part, 0, cells, y * cols, part.Length);
        }
        CURSOR_INFO ci;
        bool vis = GetConsoleCursorInfo(h, out ci) && ci.Visible != 0;
        int cx = info.Cursor.X - info.Window.Left, cy = info.Cursor.Y - info.Window.Top;
        var sb = new StringBuilder(cols * rows + 256);
        for (int r = 0; r < rows; r++)
        {
            int end = cols - 1;
            while (end >= 0 && cells[r * cols + end].Ch == ' ' && ((cells[r * cols + end].Attr >> 4) & 0xF) == 0 && (cells[r * cols + end].Attr & 0x4000) == 0) end--;
            int cur = -1;
            for (int c = 0; c <= end; c++)
            {
                var cell = cells[r * cols + c];
                if ((cell.Attr & 0x200) != 0) continue; // second half of a wide character
                int a = cell.Attr & 0xC0FF;
                if (a != cur) { sb.Append(Sgr(a)); cur = a; }
                sb.Append(cell.Ch == '\0' ? ' ' : cell.Ch);
            }
            sb.Append("\x1b[0m\x1b[K");
            if (r < rows - 1) sb.Append("\r\n");
        }
        string vt = Convert.ToBase64String(Encoding.UTF8.GetBytes(sb.ToString()));
        return "F " + cols + " " + rows + " " + cx + " " + cy + " " + (vis ? 1 : 0) + " " + vt;
    }

    static string Sgr(int a)
    {
        int fg = a & 0xF, bg = (a >> 4) & 0xF;
        var s = new StringBuilder("\x1b[0");
        // light grey on black is the console default: use the terminal's own colours there
        if (fg != 7) s.Append(';').Append(((fg & 8) != 0 ? 90 : 30) + WinToAnsi[fg & 7]);
        if (bg != 0) s.Append(';').Append(((bg & 8) != 0 ? 100 : 40) + WinToAnsi[bg & 7]);
        if ((a & 0x4000) != 0) s.Append(";7");
        if ((a & 0x8000) != 0) s.Append(";4");
        return s.Append('m').ToString();
    }

    static void ReadInput(Stream stdin, IntPtr inH)
    {
        var r = new StreamReader(stdin, Encoding.UTF8);
        string line;
        while ((line = r.ReadLine()) != null)
        {
            if (!line.StartsWith("I ")) continue;
            var p = line.Substring(2).Split(' ');
            var recs = new INPUT_RECORD[(p.Length / 3) * 2];
            int k = 0;
            for (int i = 0; i + 2 < p.Length; i += 3)
            {
                ushort vk = ushort.Parse(p[i]); char ch = (char)ushort.Parse(p[i + 1]); uint ctrl = uint.Parse(p[i + 2]);
                ushort scan = (ushort)MapVirtualKeyW(vk, 0);
                recs[k++] = new INPUT_RECORD { EventType = 1, KeyDown = 1, Repeat = 1, Vk = vk, Scan = scan, Ch = ch, Ctrl = ctrl };
                recs[k++] = new INPUT_RECORD { EventType = 1, KeyDown = 0, Repeat = 1, Vk = vk, Scan = scan, Ch = ch, Ctrl = ctrl };
            }
            uint written;
            if (k > 0) WriteConsoleInput(inH, recs, (uint)k, out written);
        }
        Environment.Exit(0); // VoxStorm closed the pipe
    }
}
