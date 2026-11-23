[CmdletBinding()]
param([Parameter(Mandatory=$true)][string]$ExecutablePath,[Parameter(Mandatory=$true)][string]$Version)
$ErrorActionPreference='Stop'
$gxExecutable=[IO.Path]::GetFullPath($ExecutablePath)
if([IO.Path]::GetFileName($gxExecutable) -cne 'Gx.exe'){throw 'Version resources may only be stamped on the named Gx.exe build copy.'}
if($Version -notmatch '^\d+\.\d+\.\d+$' -or @($Version.Split('.')|Where-Object{[long]$_ -gt 65535}).Count){throw 'Use a three-part numeric Windows version.'}
$gxItem=Get-Item -LiteralPath $gxExecutable -Force
if($gxItem.PSIsContainer -or $gxItem.IsReadOnly -or ($gxItem.Attributes -band [IO.FileAttributes]::ReparsePoint)){throw 'The selected executable must be an ordinary writable build copy.'}
$gxParent=Split-Path -Parent $gxExecutable
$gxProbe=$gxParent
while($gxProbe){if((Get-Item -LiteralPath $gxProbe -Force).Attributes -band [IO.FileAttributes]::ReparsePoint){throw 'Linked parent directories are not build inputs.'};$gxNext=Split-Path -Parent $gxProbe;if($gxNext -eq $gxProbe){break};$gxProbe=$gxNext}
$gxMarkerPath=Join-Path $gxParent '.guangxuan-build.json'
$gxMarkerItem=Get-Item -LiteralPath $gxMarkerPath -Force
if($gxMarkerItem.PSIsContainer -or ($gxMarkerItem.Attributes -band [IO.FileAttributes]::ReparsePoint)){throw 'A regular build marker is required.'}
$gxMarker=Get-Content -LiteralPath $gxMarkerPath -Raw -Encoding UTF8|ConvertFrom-Json
if($gxMarker.product -ne 'Gx' -or $gxMarker.state -ne 'building' -or $gxMarker.version -ne $Version){throw 'Only the current in-progress Gx build copy may be stamped; completed installations are not inputs.'}
if(-not ('Gx.PatchVersionResource' -as [type])){
Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Text;
namespace Gx {
  public static class PatchVersionResource {
    private delegate bool EnumNames(IntPtr module, IntPtr type, IntPtr name, IntPtr argument);
    private delegate bool EnumLanguages(IntPtr module, IntPtr type, IntPtr name, ushort language, IntPtr argument);
    [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] private static extern IntPtr LoadLibraryEx(string file, IntPtr reserved, uint flags);
    [DllImport("kernel32.dll", SetLastError=true)] private static extern bool FreeLibrary(IntPtr module);
    [DllImport("kernel32.dll", EntryPoint="EnumResourceNamesW", SetLastError=true)] private static extern bool EnumResourceNames(IntPtr module, IntPtr type, EnumNames callback, IntPtr argument);
    [DllImport("kernel32.dll", EntryPoint="EnumResourceLanguagesW", SetLastError=true)] private static extern bool EnumResourceLanguages(IntPtr module, IntPtr type, IntPtr name, EnumLanguages callback, IntPtr argument);
    [DllImport("kernel32.dll", EntryPoint="FindResourceExW", SetLastError=true)] private static extern IntPtr FindResourceEx(IntPtr module, IntPtr type, IntPtr name, ushort language);
    [DllImport("kernel32.dll", SetLastError=true)] private static extern uint SizeofResource(IntPtr module, IntPtr resource);
    [DllImport("kernel32.dll", SetLastError=true)] private static extern IntPtr LoadResource(IntPtr module, IntPtr resource);
    [DllImport("kernel32.dll", SetLastError=true)] private static extern IntPtr LockResource(IntPtr resource);
    [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] private static extern IntPtr BeginUpdateResource(string file, bool deleteExisting);
    [DllImport("kernel32.dll", EntryPoint="UpdateResourceW", SetLastError=true)] private static extern bool UpdateResource(IntPtr update, IntPtr type, IntPtr name, ushort language, byte[] bytes, uint length);
    [DllImport("kernel32.dll", SetLastError=true)] private static extern bool EndUpdateResource(IntPtr update, bool discard);
    private sealed class Resource { public ushort? Id; public string Name; public ushort Language; public byte[] Bytes; }
    private static Exception Failure(string operation) { return new Win32Exception(Marshal.GetLastWin32Error(),operation); }
    private static int Align(int offset) { return (offset+3)&~3; }
    private static void Put32(byte[] bytes,int offset,uint value) { Buffer.BlockCopy(BitConverter.GetBytes(value),0,bytes,offset,4); }
    private static void Rewrite(byte[] bytes,int offset,int bound,Dictionary<string,string> strings,HashSet<string> found,uint high,uint low) {
      if(offset+6>bound) throw new InvalidOperationException("Truncated version block.");
      int length=BitConverter.ToUInt16(bytes,offset), valueLength=BitConverter.ToUInt16(bytes,offset+2), type=BitConverter.ToUInt16(bytes,offset+4), end=offset+length;
      if(length<6 || end>bound) throw new InvalidOperationException("Invalid version block bounds.");
      int cursor=offset+6, keyStart=cursor;
      while(cursor+2<=end && BitConverter.ToUInt16(bytes,cursor)!=0) cursor+=2;
      if(cursor+2>end) throw new InvalidOperationException("Unterminated version key.");
      string key=Encoding.Unicode.GetString(bytes,keyStart,cursor-keyStart); cursor=Align(cursor+2);
      int valueBytes=type==1?valueLength*2:valueLength;
      if(cursor+valueBytes>end) throw new InvalidOperationException("Version value escaped its block.");
      if(key=="VS_VERSION_INFO") {
        if(type!=0 || valueBytes<52 || BitConverter.ToUInt32(bytes,cursor)!=0xFEEF04BD) throw new InvalidOperationException("Missing fixed version information.");
        Put32(bytes,cursor+8,high); Put32(bytes,cursor+12,low); Put32(bytes,cursor+16,high); Put32(bytes,cursor+20,low); found.Add(key);
      }
      string replacement;
      if(type==1 && strings.TryGetValue(key,out replacement)) {
        byte[] value=Encoding.Unicode.GetBytes(replacement+"\0");
        if(value.Length>valueBytes) throw new InvalidOperationException("A version string exceeds its existing verified resource capacity: "+key);
        Array.Clear(bytes,cursor,valueBytes); Buffer.BlockCopy(value,0,bytes,cursor,value.Length);
        Buffer.BlockCopy(BitConverter.GetBytes((ushort)(replacement.Length+1)),0,bytes,offset+2,2); found.Add(key);
      }
      int child=Align(cursor+valueBytes);
      while(child+6<=end && BitConverter.ToUInt16(bytes,child)!=0) { int childLength=BitConverter.ToUInt16(bytes,child); Rewrite(bytes,child,end,strings,found,high,low); child=Align(child+childLength); }
    }
    public static int Stamp(string file,string version) {
      string[] parts=version.Split('.'); ushort major=ushort.Parse(parts[0]),minor=ushort.Parse(parts[1]),patch=ushort.Parse(parts[2]);
      uint high=((uint)major<<16)|minor,low=(uint)patch<<16;
      var strings=new Dictionary<string,string>{{"FileVersion",version},{"ProductVersion",version},{"ProductName","Gx"},{"FileDescription","Gx"},{"InternalName","Gx"},{"OriginalFilename","Gx.exe"}};
      var resources=new List<Resource>(); IntPtr module=LoadLibraryEx(file,IntPtr.Zero,0x22);
      if(module==IntPtr.Zero) throw Failure("Load version resources");
      try {
        EnumNames names=(m,t,n,a)=>{
          ushort? id=((ulong)n.ToInt64()>>16)==0?(ushort?)((ushort)n.ToInt64()):null; string name=id.HasValue?null:Marshal.PtrToStringUni(n);
          EnumLanguages languages=(lm,lt,ln,language,la)=>{ IntPtr entry=FindResourceEx(lm,lt,ln,language); uint size=SizeofResource(lm,entry); IntPtr data=LockResource(LoadResource(lm,entry)); if(entry==IntPtr.Zero || data==IntPtr.Zero || size<6 || size>65535) throw Failure("Read version resource"); byte[] bytes=new byte[size]; Marshal.Copy(data,bytes,0,(int)size); resources.Add(new Resource{Id=id,Name=name,Language=language,Bytes=bytes}); return true; };
          if(!EnumResourceLanguages(m,t,n,languages,IntPtr.Zero)) throw Failure("Enumerate version languages"); return true;
        };
        if(!EnumResourceNames(module,new IntPtr(16),names,IntPtr.Zero) || resources.Count==0) throw Failure("Enumerate version resources");
      } finally { FreeLibrary(module); }
      foreach(var resource in resources) { var found=new HashSet<string>(); Rewrite(resource.Bytes,0,resource.Bytes.Length,strings,found,high,low); foreach(string required in new[]{"VS_VERSION_INFO","FileVersion","ProductVersion","ProductName","FileDescription"}) if(!found.Contains(required)) throw new InvalidOperationException("Required version field is absent: "+required); }
      IntPtr update=BeginUpdateResource(file,false); if(update==IntPtr.Zero) throw Failure("Begin version resource update"); bool committed=false;
      try { foreach(var resource in resources) { IntPtr name=resource.Id.HasValue?new IntPtr(resource.Id.Value):Marshal.StringToHGlobalUni(resource.Name); try { if(!UpdateResource(update,new IntPtr(16),name,resource.Language,resource.Bytes,(uint)resource.Bytes.Length)) throw Failure("Update version resource"); } finally { if(!resource.Id.HasValue) Marshal.FreeHGlobal(name); } } if(!EndUpdateResource(update,false)) throw Failure("Commit version resource update"); committed=true; } finally { if(!committed) EndUpdateResource(update,true); }
      return resources.Count;
    }
  }
}
'@
}
$gxResourceCount=[Gx.PatchVersionResource]::Stamp($gxExecutable,$Version)
$gxInfo=[Diagnostics.FileVersionInfo]::GetVersionInfo($gxExecutable)
if($gxInfo.FileVersion -ne $Version -or $gxInfo.ProductVersion -ne $Version -or $gxInfo.ProductName -ne 'Gx' -or $gxInfo.FileDescription -ne 'Gx'){throw 'The prepared native version resource verification failed.'}
[ordered]@{verified=$true;version=$Version;fileVersion=$gxInfo.FileVersion;productVersion=$gxInfo.ProductVersion;productName=$gxInfo.ProductName;fileDescription=$gxInfo.FileDescription;versionResourcesUpdated=$gxResourceCount;onlyNamedBuildCopyModified=$true;networkCalls=0}|ConvertTo-Json
