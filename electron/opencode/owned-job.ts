import koffi from "koffi";

/** Kill-on-close ownership only, not an execution/security sandbox. The OS
 * closes the Job handle on a Desktop crash, terminating the owned runtime tree. */
export class OwnedProcessJob {
  private handle: unknown;
  private readonly api = process.platform === "win32" ? (() => {
    const kernel = koffi.load("kernel32.dll");
    return {
      create: kernel.func("void * __stdcall CreateJobObjectW(void *attributes, str16 name)"),
      set: kernel.func("int __stdcall SetInformationJobObject(void *job, int infoClass, void *information, uint32_t size)"),
      open: kernel.func("void * __stdcall OpenProcess(uint32_t access, int inherit, uint32_t pid)"),
      assign: kernel.func("int __stdcall AssignProcessToJobObject(void *job, void *process)"),
      close: kernel.func("int __stdcall CloseHandle(void *handle)"),
    };
  })() : undefined;
  attach(pid: number) {
    if (!this.api || process.arch !== "x64") throw new Error("Reviewed process ownership requires Windows x64.");
    const a = this.api; this.handle = a.create(null, null);
    if (!this.handle) throw new Error("Could not create the owned runtime Job.");
    const limits = Buffer.alloc(144); // Win64 JOBOBJECT_EXTENDED_LIMIT_INFORMATION
    limits.writeUInt32LE(0x2000, 16); // JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
    if (!a.set(this.handle, 9, limits, limits.length)) { this.close(); throw new Error("Could not set owned runtime Job limits."); }
    const childHandle = a.open(0x0101, 0, pid); // SET_QUOTA | TERMINATE, no broad host process rights
    try { if (!childHandle || !a.assign(this.handle, childHandle)) { this.close(); throw new Error("Could not assign OpenCode to its owned Job."); } }
    finally { if (childHandle) a.close(childHandle); }
  }
  close() { if (this.handle && this.api) { this.api.close(this.handle); this.handle = undefined; } }
}
