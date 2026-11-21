[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$ExecutablePath,
    [Parameter(Mandatory = $true)][string]$IconPath
)

$ErrorActionPreference = 'Stop'
if ([Environment]::OSVersion.Platform -ne [PlatformID]::Win32NT) { throw 'Windows icon resources can only be updated on Windows.' }
$executable = [IO.Path]::GetFullPath($ExecutablePath)
$icon = [IO.Path]::GetFullPath($IconPath)
if (-not (Test-Path -LiteralPath $executable -PathType Leaf) -or [IO.Path]::GetExtension($executable) -ine '.exe') {
    throw 'Select an existing Windows executable.'
}
if (-not (Test-Path -LiteralPath $icon -PathType Leaf)) { throw 'The ICO file does not exist.' }

if (-not ('Gx.WindowsIcon' -as [type])) {
    Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.IO;
using System.Runtime.InteropServices;

namespace Gx {
    public static class WindowsIcon {
        private const int GroupIcon = 14;
        private const int IconImage = 3;
        private sealed class Resource {
            public ushort? Id;
            public string Name;
            public ushort Language;
            public IntPtr AllocateName(out bool allocated) {
                allocated = !Id.HasValue;
                return Id.HasValue ? new IntPtr(Id.Value) : Marshal.StringToHGlobalUni(Name);
            }
        }
        private sealed class Icon {
            public byte[] Header;
            public byte[] Data;
        }
        private delegate bool EnumNames(IntPtr module, IntPtr type, IntPtr name, IntPtr parameter);
        private delegate bool EnumLanguages(IntPtr module, IntPtr type, IntPtr name, ushort language, IntPtr parameter);
        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        private static extern IntPtr LoadLibraryEx(string file, IntPtr reserved, uint flags);
        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern bool FreeLibrary(IntPtr module);
        [DllImport("kernel32.dll", EntryPoint = "EnumResourceNamesW", SetLastError = true)]
        private static extern bool EnumResourceNames(IntPtr module, IntPtr type, EnumNames callback, IntPtr parameter);
        [DllImport("kernel32.dll", EntryPoint = "EnumResourceLanguagesW", SetLastError = true)]
        private static extern bool EnumResourceLanguages(IntPtr module, IntPtr type, IntPtr name, EnumLanguages callback, IntPtr parameter);
        [DllImport("kernel32.dll", EntryPoint = "FindResourceExW", SetLastError = true)]
        private static extern IntPtr FindResourceEx(IntPtr module, IntPtr type, IntPtr name, ushort language);
        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern uint SizeofResource(IntPtr module, IntPtr resource);
        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern IntPtr LoadResource(IntPtr module, IntPtr resource);
        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern IntPtr LockResource(IntPtr resource);
        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        private static extern IntPtr BeginUpdateResource(string file, bool deleteExistingResources);
        [DllImport("kernel32.dll", EntryPoint = "UpdateResourceW", SetLastError = true)]
        private static extern bool UpdateResource(IntPtr update, IntPtr type, IntPtr name, ushort language, byte[] data, uint length);
        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern bool EndUpdateResource(IntPtr update, bool discard);

        private static Exception Failure(string operation) { return new Win32Exception(Marshal.GetLastWin32Error(), operation); }
        private static List<Icon> ReadIcons(string file) {
            byte[] data = File.ReadAllBytes(file);
            if (data.Length < 22 || BitConverter.ToUInt16(data, 0) != 0 || BitConverter.ToUInt16(data, 2) != 1)
                throw new InvalidDataException("Invalid ICO header.");
            int count = BitConverter.ToUInt16(data, 4);
            if (count < 1 || count > 256 || 6 + count * 16 > data.Length)
                throw new InvalidDataException("Invalid ICO directory.");
            var result = new List<Icon>();
            for (int i = 0; i < count; i++) {
                int entry = 6 + 16 * i;
                uint size = BitConverter.ToUInt32(data, entry + 8);
                uint offset = BitConverter.ToUInt32(data, entry + 12);
                if (size == 0 || size > int.MaxValue || offset < 6 + count * 16 || (long)offset + size > data.Length)
                    throw new InvalidDataException("Invalid ICO image bounds.");
                var header = new byte[12];
                var image = new byte[(int)size];
                Buffer.BlockCopy(data, entry, header, 0, 12);
                Buffer.BlockCopy(data, (int)offset, image, 0, (int)size);
                result.Add(new Icon { Header = header, Data = image });
            }
            return result;
        }
        private static List<Resource> Groups(IntPtr module) {
            var result = new List<Resource>();
            Exception failure = null;
            EnumNames names = delegate(IntPtr handle, IntPtr type, IntPtr name, IntPtr parameter) {
                bool numeric = (name.ToInt64() >> 16) == 0;
                ushort? id = numeric ? (ushort?)name.ToInt32() : null;
                string text = numeric ? null : Marshal.PtrToStringUni(name);
                EnumLanguages languages = delegate(IntPtr library, IntPtr kind, IntPtr key, ushort language, IntPtr ignored) {
                    result.Add(new Resource { Id = id, Name = text, Language = language });
                    return true;
                };
                if (!EnumResourceLanguages(handle, type, name, languages, IntPtr.Zero)) {
                    failure = Failure("Cannot enumerate icon resource languages.");
                    return false;
                }
                return true;
            };
            if (!EnumResourceNames(module, new IntPtr(GroupIcon), names, IntPtr.Zero) && failure == null) {
                int error = Marshal.GetLastWin32Error();
                if (error != 1813 && error != 1814) failure = new Win32Exception(error, "Cannot enumerate icon resources.");
            }
            if (failure != null) throw failure;
            return result;
        }
        private static byte[] ReadResource(IntPtr module, int type, Resource name) {
            bool allocated;
            IntPtr key = name.AllocateName(out allocated);
            try {
                IntPtr resource = FindResourceEx(module, new IntPtr(type), key, name.Language);
                if (resource == IntPtr.Zero) throw Failure("Cannot find an icon resource.");
                uint size = SizeofResource(module, resource);
                if (size == 0 || size > int.MaxValue) throw new InvalidDataException("Invalid resource size.");
                IntPtr loaded = LoadResource(module, resource);
                IntPtr pointer = LockResource(loaded);
                if (pointer == IntPtr.Zero) throw Failure("Cannot read an icon resource.");
                var data = new byte[(int)size];
                Marshal.Copy(pointer, data, 0, data.Length);
                return data;
            } finally { if (allocated) Marshal.FreeHGlobal(key); }
        }
        private static void WriteResource(IntPtr update, int type, Resource name, byte[] data) {
            bool allocated;
            IntPtr key = name.AllocateName(out allocated);
            try {
                if (!UpdateResource(update, new IntPtr(type), key, name.Language, data, (uint)data.Length))
                    throw Failure("Cannot replace an icon resource.");
            } finally { if (allocated) Marshal.FreeHGlobal(key); }
        }
        private static byte[] GroupData(List<Icon> icons) {
            using (var buffer = new MemoryStream())
            using (var writer = new BinaryWriter(buffer)) {
                writer.Write((ushort)0); writer.Write((ushort)1); writer.Write((ushort)icons.Count);
                for (int i = 0; i < icons.Count; i++) { writer.Write(icons[i].Header); writer.Write((ushort)(i + 1)); }
                return buffer.ToArray();
            }
        }
        private static void AssertEqual(byte[] actual, byte[] expected) {
            if (actual.Length != expected.Length) throw new InvalidDataException("Embedded icon verification failed.");
            for (int i = 0; i < actual.Length; i++)
                if (actual[i] != expected[i]) throw new InvalidDataException("Embedded icon verification failed.");
        }
        public static int Replace(string executable, string iconFile) {
            List<Icon> icons = ReadIcons(iconFile);
            List<Resource> groups;
            IntPtr module = LoadLibraryEx(executable, IntPtr.Zero, 2);
            if (module == IntPtr.Zero) throw Failure("Cannot inspect the Windows executable.");
            try { groups = Groups(module); } finally { FreeLibrary(module); }
            if (groups.Count == 0) groups.Add(new Resource { Id = 1, Language = 0 });
            byte[] groupData = GroupData(icons);
            IntPtr update = BeginUpdateResource(executable, false);
            if (update == IntPtr.Zero) throw Failure("Cannot update the Windows executable.");
            try {
                var languages = new HashSet<ushort>();
                foreach (Resource group in groups) {
                    if (languages.Add(group.Language)) {
                        for (int i = 0; i < icons.Count; i++)
                            WriteResource(update, IconImage, new Resource { Id = (ushort)(i + 1), Language = group.Language }, icons[i].Data);
                    }
                    WriteResource(update, GroupIcon, group, groupData);
                }
                if (!EndUpdateResource(update, false)) { update = IntPtr.Zero; throw Failure("Cannot commit icon resources."); }
                update = IntPtr.Zero;
            } finally { if (update != IntPtr.Zero) EndUpdateResource(update, true); }
            module = LoadLibraryEx(executable, IntPtr.Zero, 2);
            if (module == IntPtr.Zero) throw Failure("Cannot verify the Windows executable.");
            try {
                foreach (Resource group in groups) {
                    AssertEqual(ReadResource(module, GroupIcon, group), groupData);
                    for (int i = 0; i < icons.Count; i++)
                        AssertEqual(ReadResource(module, IconImage, new Resource { Id = (ushort)(i + 1), Language = group.Language }), icons[i].Data);
                }
            } finally { FreeLibrary(module); }
            return icons.Count;
        }
    }
}
'@
}

# Brand a temporary copy, then replace the selected build output after verification.
$temporary = Join-Path (Split-Path -Parent $executable) ('.gx-icon-' + [Guid]::NewGuid().ToString('N') + '.exe')
try {
    Copy-Item -LiteralPath $executable -Destination $temporary
    $sizes = [Gx.WindowsIcon]::Replace($temporary, $icon)
    Move-Item -LiteralPath $temporary -Destination $executable -Force
    [ordered]@{ executable = $executable; icon = $icon; sizes = $sizes; verified = $true } | ConvertTo-Json -Compress
} finally {
    if (Test-Path -LiteralPath $temporary -PathType Leaf) { Remove-Item -LiteralPath $temporary -Force }
}
