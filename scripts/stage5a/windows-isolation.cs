// Development-only, fixed canary workload. NOT a production arbitrary-code launcher.
// Tests an actual AppContainer token with zero network capabilities and a one-process Job.
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Net;
using System.Net.Sockets;
using System.Runtime.InteropServices;
using System.Security.AccessControl;
using System.Security.Principal;
using System.Text;
using System.Web.Script.Serialization;

public static class IsolationProbe {
  [StructLayout(LayoutKind.Sequential)] struct STARTUPINFO { public int cb; public IntPtr reserved, desktop, title; public int x,y,cx,cy,xChars,yChars,fill,flags; public short show, reserved2; public IntPtr reserved3,input,output,error; }
  [StructLayout(LayoutKind.Sequential)] struct STARTUPINFOEX { public STARTUPINFO info; public IntPtr attributes; }
  [StructLayout(LayoutKind.Sequential)] struct PROCESS_INFORMATION { public IntPtr process,thread; public int pid,tid; }
  [StructLayout(LayoutKind.Sequential)] struct SECURITY_CAPABILITIES { public IntPtr sid, capabilities; public int count,reserved; }
  [StructLayout(LayoutKind.Sequential)] struct BASIC_LIMIT { public long processTime,jobTime; public uint flags; public UIntPtr minWorking,maxWorking; public uint activeProcesses; public UIntPtr affinity; public uint priority,scheduling; }
  [StructLayout(LayoutKind.Sequential)] struct IO_COUNTERS { public ulong a,b,c,d,e,f; }
  [StructLayout(LayoutKind.Sequential)] struct EXTENDED_LIMIT { public BASIC_LIMIT basic; public IO_COUNTERS io; public UIntPtr processMemory,jobMemory,peakProcess,peakJob; }
  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)] struct CREDENTIAL { public uint flags,type; public string target,comment; public long lastWritten; public uint size; public IntPtr blob; public uint persist,count; public IntPtr attributes; public string alias,user; }
  [DllImport("userenv.dll", CharSet=CharSet.Unicode)] static extern int CreateAppContainerProfile(string name,string display,string description,IntPtr caps,uint count,out IntPtr sid);
  [DllImport("userenv.dll", CharSet=CharSet.Unicode)] static extern int DeleteAppContainerProfile(string name);
  [DllImport("advapi32.dll")] static extern IntPtr FreeSid(IntPtr sid);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool InitializeProcThreadAttributeList(IntPtr list,int count,int flags,ref IntPtr size);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool UpdateProcThreadAttribute(IntPtr list,uint flags,IntPtr attribute,IntPtr value,IntPtr size,IntPtr previous,IntPtr returned);
  [DllImport("kernel32.dll")] static extern void DeleteProcThreadAttributeList(IntPtr list);
  [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern bool CreateProcessW(string app,StringBuilder command,IntPtr processAttributes,IntPtr threadAttributes,bool inherit,uint flags,IntPtr environment,string cwd,ref STARTUPINFOEX startup,out PROCESS_INFORMATION process);
  [DllImport("kernel32.dll",SetLastError=true)] static extern IntPtr CreateJobObject(IntPtr attributes,string name);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool SetInformationJobObject(IntPtr job,int cls,ref EXTENDED_LIMIT limit,int length);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool AssignProcessToJobObject(IntPtr job,IntPtr process);
  [DllImport("kernel32.dll")] static extern uint ResumeThread(IntPtr thread);
  [DllImport("kernel32.dll")] static extern uint WaitForSingleObject(IntPtr handle,uint ms);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
  [DllImport("kernel32.dll")] static extern bool TerminateProcess(IntPtr handle,uint code);
  [DllImport("kernel32.dll")] static extern bool GetExitCodeProcess(IntPtr handle,out uint code);
  [DllImport("kernel32.dll",SetLastError=true)] static extern IntPtr OpenProcess(uint access,bool inherit,int pid);
  [DllImport("kernel32.dll")] static extern IntPtr GetCurrentProcess();
  [DllImport("advapi32.dll",SetLastError=true)] static extern bool OpenProcessToken(IntPtr process,uint access,out IntPtr token);
  [DllImport("advapi32.dll",SetLastError=true)] static extern bool GetTokenInformation(IntPtr token,int cls,out int value,int size,out int returned);
  [DllImport("advapi32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern bool CredWriteW(ref CREDENTIAL cred,uint flags);
  [DllImport("advapi32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern bool CredReadW(string target,uint type,uint flags,out IntPtr cred);
  [DllImport("advapi32.dll",CharSet=CharSet.Unicode)] static extern bool CredDeleteW(string target,uint type,uint flags);
  [DllImport("advapi32.dll")] static extern void CredFree(IntPtr cred);

  static string Quote(string s) {
    var b=new StringBuilder("\""); int slashes=0;
    foreach(char c in s) { if(c=='\\') { slashes++; continue; }
      b.Append('\\',c=='\"' ? slashes*2+1 : slashes); b.Append(c); slashes=0; }
    b.Append('\\',slashes*2); b.Append('"'); return b.ToString();
  }
  static bool Denied(Action action) { try { action(); return false; } catch { return true; } }
  static bool CanConnect(string host,int port) {
    try { using(var tcp=new TcpClient()) { var task=tcp.ConnectAsync(host,port); if(!task.Wait(2000)) return false; return tcp.Connected; } } catch { return false; }
  }
  static void Check(bool ok,string operation) { if(!ok) throw new Exception(operation+" failed, Win32="+Marshal.GetLastWin32Error()); }
  static Dictionary<string,bool> Child(string[] args) {
    string allowed=args[1], outside=args[2], credential=args[5]; int pid=int.Parse(args[3]), port=int.Parse(args[4]);
    var checks=new Dictionary<string,bool>();
    checks["insideRead"]=!Denied(()=>File.ReadAllText(Path.Combine(allowed,"input.txt")));
    checks["insideWrite"]=!Denied(()=>File.WriteAllText(Path.Combine(allowed,"written.txt"),"fixture"));
    checks["outsideReadBlocked"]=Denied(()=>File.ReadAllText(outside));
    checks["outsideWriteBlocked"]=Denied(()=>File.WriteAllText(outside,"fixture"));
    checks["junctionReadBlocked"]=Denied(()=>File.ReadAllText(Path.Combine(allowed,"outside-link","canary.txt")));
    checks["loopbackBlocked"]=!CanConnect("127.0.0.1",port);
    checks["internetBlocked"]=!CanConnect("1.1.1.1",443);
    IntPtr handle=OpenProcess(0x0010|0x0020|0x0002,false,pid);
    checks["hostProcessAccessBlocked"]=handle==IntPtr.Zero; if(handle!=IntPtr.Zero) CloseHandle(handle);
    checks["childProcessBlocked"]=Denied(()=> { var p=Process.Start(new ProcessStartInfo(Path.Combine(allowed,"probe.exe"),"--noop") { UseShellExecute=false,CreateNoWindow=true }); if(!p.WaitForExit(3000)) { p.Kill(); throw new Exception("child timed out"); } });
    IntPtr cred; bool read=CredReadW(credential,1,0,out cred); checks["credentialReadBlocked"]=!read; if(read) CredFree(cred);
    checks["credentialEnvironmentAbsent"]=Environment.GetEnvironmentVariable("FLOWCODE_CANARY_KEY")==null;
    IntPtr token; int app=0,returned; Check(OpenProcessToken(GetCurrentProcess(),8,out token),"OpenProcessToken");
    try { Check(GetTokenInformation(token,29,out app,4,out returned),"GetTokenInformation"); } finally { CloseHandle(token); }
    checks["appContainerToken"]=app!=0;
    File.WriteAllText(Path.Combine(allowed,args[6]+".json"),new JavaScriptSerializer().Serialize(checks));
    return checks;
  }
  public static int Main(string[] args) {
    if(args.Length>0 && args[0]=="--noop") return 0;
    if(args.Length>0 && args[0]=="--child") { try { Child(args); return 0; } catch { return 2; } }
    string root=Path.GetFullPath(args[0]), allowed=Path.Combine(root,"allowed"), outside=Path.Combine(root,"outside","canary.txt");
    if(!Path.GetFileName(root).StartsWith("flowcode-stage5a-isolation-") || Path.GetDirectoryName(root)!=Path.GetFullPath(Path.GetTempPath()).TrimEnd(Path.DirectorySeparatorChar)) throw new Exception("Unsafe probe root.");
    string appName="FlowCode.Stage5A."+Guid.NewGuid().ToString("N"), credential="FlowCode.Stage5A/"+Guid.NewGuid().ToString("N");
    IntPtr sid=IntPtr.Zero,job=IntPtr.Zero,attrs=IntPtr.Zero,capsPtr=IntPtr.Zero,envPtr=IntPtr.Zero,secret=IntPtr.Zero;
    PROCESS_INFORMATION child=new PROCESS_INFORMATION(); bool madeProfile=false,wroteCredential=false;
    var listener=new TcpListener(IPAddress.Loopback,0);
    try {
      Directory.CreateDirectory(allowed); Directory.CreateDirectory(Path.GetDirectoryName(outside));
      File.WriteAllText(outside,"synthetic credential/session outside canary"); File.WriteAllText(Path.Combine(allowed,"input.txt"),"fixture");
      File.Copy(Process.GetCurrentProcess().MainModule.FileName,Path.Combine(allowed,"probe.exe"),true);
      listener.Start(); int port=((IPEndPoint)listener.LocalEndpoint).Port;
      secret=Marshal.StringToCoTaskMemUni("synthetic-only");
      var cred=new CREDENTIAL { type=1,target=credential,persist=1,size=28,blob=secret,user="fixture" };
      Check(CredWriteW(ref cred,0),"CredWrite fixture"); wroteCredential=true;
      string common="--child "+Quote(allowed)+" "+Quote(outside)+" "+Process.GetCurrentProcess().Id+" "+port+" "+Quote(credential)+" ";
      var controlInfo=new ProcessStartInfo(Path.Combine(allowed,"probe.exe"),common+"control") { UseShellExecute=false,CreateNoWindow=true };
      controlInfo.EnvironmentVariables["FLOWCODE_CANARY_KEY"]="synthetic-only";
      using(var control=Process.Start(controlInfo)) { if(!control.WaitForExit(20000)) { control.Kill(); throw new Exception("Control timeout"); } Check(control.ExitCode==0,"control child"); }
      int hr=CreateAppContainerProfile(appName,appName,"Temporary FlowCode 5A canary",IntPtr.Zero,0,out sid);
      if(hr!=0) Marshal.ThrowExceptionForHR(hr); madeProfile=true;
      var identity=new SecurityIdentifier(sid); var acl=Directory.GetAccessControl(allowed);
      acl.AddAccessRule(new FileSystemAccessRule(identity,FileSystemRights.Modify|FileSystemRights.Synchronize,InheritanceFlags.ContainerInherit|InheritanceFlags.ObjectInherit,PropagationFlags.None,AccessControlType.Allow));
      Directory.SetAccessControl(allowed,acl);
      IntPtr length=IntPtr.Zero; InitializeProcThreadAttributeList(IntPtr.Zero,1,0,ref length); attrs=Marshal.AllocHGlobal(length);
      Check(InitializeProcThreadAttributeList(attrs,1,0,ref length),"attributes");
      var caps=new SECURITY_CAPABILITIES { sid=sid }; capsPtr=Marshal.AllocHGlobal(Marshal.SizeOf(caps)); Marshal.StructureToPtr(caps,capsPtr,false);
      Check(UpdateProcThreadAttribute(attrs,0,new IntPtr(0x20009),capsPtr,new IntPtr(Marshal.SizeOf(caps)),IntPtr.Zero,IntPtr.Zero),"AppContainer capabilities");
      job=CreateJobObject(IntPtr.Zero,null); Check(job!=IntPtr.Zero,"job");
      var limit=new EXTENDED_LIMIT(); limit.basic.flags=0x2000|0x8; limit.basic.activeProcesses=1;
      Check(SetInformationJobObject(job,9,ref limit,Marshal.SizeOf(limit)),"job limits");
      string win=Environment.GetEnvironmentVariable("SystemRoot");
      string env="ALLUSERSPROFILE="+Environment.GetEnvironmentVariable("ALLUSERSPROFILE")+"\0APPDATA="+allowed+"\0LOCALAPPDATA="+allowed+
        "\0PATH="+Path.Combine(win,"System32")+"\0SystemDrive="+Path.GetPathRoot(win).TrimEnd('\\')+"\0SystemRoot="+win+
        "\0TEMP="+allowed+"\0TMP="+allowed+"\0USERPROFILE="+allowed+"\0WINDIR="+win+"\0\0";
      envPtr=Marshal.StringToHGlobalUni(env);
      var startup=new STARTUPINFOEX(); startup.info.cb=Marshal.SizeOf(startup); startup.attributes=attrs;
      Check(CreateProcessW(Path.Combine(allowed,"probe.exe"),new StringBuilder(Quote(Path.Combine(allowed,"probe.exe"))+" "+common+"sandbox"),IntPtr.Zero,IntPtr.Zero,false,0x80000|0x4|0x08000000|0x400,envPtr,allowed,ref startup,out child),"CreateProcess AppContainer");
      Check(AssignProcessToJobObject(job,child.process),"assign suspended process"); ResumeThread(child.thread);
      if(WaitForSingleObject(child.process,20000)!=0) { TerminateProcess(child.process,3); throw new Exception("Sandbox timeout"); }
      uint exit; GetExitCodeProcess(child.process,out exit); Check(exit==0,"sandbox child exit="+exit);
      var serializer=new JavaScriptSerializer();
      var result=new Dictionary<string,object> { {"schemaVersion",1},{"os",Environment.OSVersion.Version.ToString()},
        {"candidate","AppContainer (zero capabilities) + one-process kill-on-close Job + explicit directory ACL + minimal environment"},
        {"control",serializer.DeserializeObject(File.ReadAllText(Path.Combine(allowed,"control.json")))},
        {"sandbox",serializer.DeserializeObject(File.ReadAllText(Path.Combine(allowed,"sandbox.json")))},
        {"unreviewedCodeExecutionEnabled",false} };
      // Same actual AppContainer/Job boundary, now exercised by the project's Node runtime.
      string node=Path.Combine(allowed,"node.exe"), nodeScript=Path.Combine(allowed,"node-canary.mjs");
      File.Copy(args[1],node,true); File.Copy(args[2],nodeScript,true);
      string nodeArgs="--input-type=module --eval "+Quote(File.ReadAllText(nodeScript))+" -- flowcode-node-canary "+Quote(allowed)+" "+Quote(outside)+" "+port+" ";
      var nodeControlInfo=new ProcessStartInfo(node,nodeArgs+"control") { UseShellExecute=false,CreateNoWindow=true };
      nodeControlInfo.EnvironmentVariables["FLOWCODE_CANARY_KEY"]="synthetic-only";
      using(var control=Process.Start(nodeControlInfo)) { if(!control.WaitForExit(20000)) { control.Kill(); throw new Exception("Node control timeout"); } Check(control.ExitCode==0,"Node control"); }
      CloseHandle(child.process); CloseHandle(child.thread); child=new PROCESS_INFORMATION();
      Check(CreateProcessW(node,new StringBuilder(Quote(node)+" "+nodeArgs+"sandbox"),IntPtr.Zero,IntPtr.Zero,false,0x80000|0x4|0x08000000|0x400,envPtr,allowed,ref startup,out child),"Node AppContainer");
      Check(AssignProcessToJobObject(job,child.process),"Node job assignment"); ResumeThread(child.thread);
      if(WaitForSingleObject(child.process,20000)!=0) { TerminateProcess(child.process,3); throw new Exception("Node sandbox timeout: "+(File.Exists(Path.Combine(allowed,"node-progress-sandbox.txt")) ? File.ReadAllText(Path.Combine(allowed,"node-progress-sandbox.txt")) : "script-not-entered")); }
      GetExitCodeProcess(child.process,out exit); Check(exit==0,"Node sandbox exit="+exit);
      result["nodeControl"]=serializer.DeserializeObject(File.ReadAllText(Path.Combine(allowed,"node-control.json")));
      result["nodeSandbox"]=serializer.DeserializeObject(File.ReadAllText(Path.Combine(allowed,"node-sandbox.json")));
      Console.WriteLine(serializer.Serialize(result)); return 0;
    } catch(Exception e) { Console.Error.WriteLine(e.Message); return 1; }
    finally {
      if(child.process!=IntPtr.Zero) { TerminateProcess(child.process,4); CloseHandle(child.process); }
      if(child.thread!=IntPtr.Zero) CloseHandle(child.thread); if(job!=IntPtr.Zero) CloseHandle(job);
      if(attrs!=IntPtr.Zero) { DeleteProcThreadAttributeList(attrs); Marshal.FreeHGlobal(attrs); }
      if(capsPtr!=IntPtr.Zero) Marshal.FreeHGlobal(capsPtr); if(envPtr!=IntPtr.Zero) Marshal.FreeHGlobal(envPtr);
      if(wroteCredential) CredDeleteW(credential,1,0); if(secret!=IntPtr.Zero) Marshal.FreeCoTaskMem(secret);
      if(madeProfile) DeleteAppContainerProfile(appName); if(sid!=IntPtr.Zero) FreeSid(sid); listener.Stop();
    }
  }
}
