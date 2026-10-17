using System;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Threading;

internal static class MouseSideHotkey
{
    private const int WH_MOUSE_LL = 14;
    private const int WM_XBUTTONDOWN = 0x020B;
    private const int WM_XBUTTONUP = 0x020C;
    private const int WM_MBUTTONDOWN = 0x0207;
    private static int _button = 1;
    private static int _virtualKey = 0x05;
    private const long TriggerDebounceTicks = TimeSpan.TicksPerMillisecond * 250;

    private static LowLevelMouseProc _callback = HookCallback;
    private static IntPtr _hook = IntPtr.Zero;
    private static int _parentProcessId;
    private static uint _mainThreadId;
    private static long _lastTriggerTicks;
    private static bool _lastPolledDown;

    [STAThread]
    private static int Main(string[] args)
    {
        if (args.Length > 0 && args[0] == "--self-test")
        {
            Console.WriteLine("READY");
            if (args.Length > 1 && args[1] != "XBUTTON1" && args[1] != "XBUTTON2" && args[1] != "MIDDLE") return 2;
            Console.WriteLine("TRIGGER");
            return 0;
        }
        if (args.Length != 2 || !int.TryParse(args[0], out _parentProcessId))
        {
            Console.Error.WriteLine("A valid parent process id is required.");
            return 2;
        }

        if (args[1] == "XBUTTON2") { _button = 2; _virtualKey = 0x06; }
        else if (args[1] == "MIDDLE") { _button = 0; _virtualKey = 0x04; }
        else if (args[1] != "XBUTTON1") return 2;
        _hook = SetHook(_callback);
        if (_hook == IntPtr.Zero)
        {
            Console.Error.WriteLine("HOOK_ERROR:" + Marshal.GetLastWin32Error());
            return 3;
        }

        Console.WriteLine("READY");
        Console.Out.Flush();
        _mainThreadId = GetCurrentThreadId();
        using (var parentTimer = new Timer(CheckParent, null, 1500, 1500))
        using (var mouseTimer = new Timer(PollMouseButton, null, 0, 12))
        {
            MSG message;
            while (GetMessage(out message, IntPtr.Zero, 0, 0) > 0)
            {
                TranslateMessage(ref message);
                DispatchMessage(ref message);
            }
        }
        UnhookWindowsHookEx(_hook);
        return 0;
    }

    private static void CheckParent(object state)
    {
        try { Process.GetProcessById(_parentProcessId); }
        catch { PostThreadMessage(_mainThreadId, 0x0012, UIntPtr.Zero, IntPtr.Zero); }
    }

    private static void PollMouseButton(object state)
    {
        bool down = (GetAsyncKeyState(_virtualKey) & 0x8000) != 0;
        if (down && !_lastPolledDown) EmitTrigger();
        _lastPolledDown = down;
    }

    private static void EmitTrigger()
    {
        long now = DateTime.UtcNow.Ticks;
        long previous = Interlocked.Read(ref _lastTriggerTicks);
        if (now - previous < TriggerDebounceTicks) return;
        Interlocked.Exchange(ref _lastTriggerTicks, now);
        Console.WriteLine("TRIGGER");
        Console.Out.Flush();
    }

    private static IntPtr SetHook(LowLevelMouseProc callback)
    {
        using (Process process = Process.GetCurrentProcess())
        using (ProcessModule module = process.MainModule)
        {
            return SetWindowsHookEx(WH_MOUSE_LL, callback, GetModuleHandle(module.ModuleName), 0);
        }
    }

    private static IntPtr HookCallback(int code, IntPtr message, IntPtr data)
    {
        if (code >= 0 && (message == (IntPtr)WM_XBUTTONDOWN || message == (IntPtr)WM_XBUTTONUP))
        {
            MSLLHOOKSTRUCT details = (MSLLHOOKSTRUCT)Marshal.PtrToStructure(data, typeof(MSLLHOOKSTRUCT));
            int button = (int)((details.mouseData >> 16) & 0xffff);
            if (button == _button)
            {
                if (message == (IntPtr)WM_XBUTTONDOWN)
                {
                    EmitTrigger();
                }
            }
        }
        if (code >= 0 && _button == 0 && message == (IntPtr)WM_MBUTTONDOWN) EmitTrigger();
        return CallNextHookEx(_hook, code, message, data);
    }

    private delegate IntPtr LowLevelMouseProc(int code, IntPtr message, IntPtr data);

    [StructLayout(LayoutKind.Sequential)]
    private struct POINT { public int x; public int y; }

    [StructLayout(LayoutKind.Sequential)]
    private struct MSLLHOOKSTRUCT
    {
        public POINT point;
        public uint mouseData;
        public uint flags;
        public uint time;
        public UIntPtr extraInfo;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct MSG
    {
        public IntPtr hwnd;
        public uint message;
        public UIntPtr wParam;
        public IntPtr lParam;
        public uint time;
        public POINT point;
    }

    [DllImport("user32.dll", SetLastError = true)]
    private static extern IntPtr SetWindowsHookEx(int hookId, LowLevelMouseProc callback, IntPtr module, uint threadId);
    [DllImport("user32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool UnhookWindowsHookEx(IntPtr hook);
    [DllImport("user32.dll")]
    private static extern IntPtr CallNextHookEx(IntPtr hook, int code, IntPtr message, IntPtr data);
    [DllImport("kernel32.dll", CharSet = CharSet.Auto, SetLastError = true)]
    private static extern IntPtr GetModuleHandle(string moduleName);
    [DllImport("user32.dll")]
    private static extern int GetMessage(out MSG message, IntPtr window, uint minimum, uint maximum);
    [DllImport("user32.dll")]
    private static extern bool TranslateMessage(ref MSG message);
    [DllImport("user32.dll")]
    private static extern IntPtr DispatchMessage(ref MSG message);
    [DllImport("user32.dll", SetLastError = true)]
    private static extern bool PostThreadMessage(uint threadId, uint message, UIntPtr wParam, IntPtr lParam);
    [DllImport("kernel32.dll")]
    private static extern uint GetCurrentThreadId();
    [DllImport("user32.dll")]
    private static extern short GetAsyncKeyState(int virtualKey);
}
