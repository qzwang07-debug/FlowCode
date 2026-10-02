import koffi from "koffi";
import { ContractIdSchema } from "../../common/execution-primitives";

export interface CredentialVault {
  read(id: string): Promise<string | undefined>;
  write(id: string, secret: string): Promise<void>;
  remove(id: string): Promise<void>;
}
let api: ReturnType<typeof load> | undefined;
function load() {
  if (process.platform !== "win32") throw new Error("Model keys require Windows Credential Manager on this platform.");
  const lib = koffi.load("advapi32.dll");
  const credential = koffi.struct("FlowCodeModelCredential5C", {
    Flags: "uint32_t", Type: "uint32_t", TargetName: "str16", Comment: "str16",
    LastWritten: koffi.struct({ low: "uint32_t", high: "uint32_t" }),
    CredentialBlobSize: "uint32_t", CredentialBlob: "void *", Persist: "uint32_t",
    AttributeCount: "uint32_t", Attributes: "void *", TargetAlias: "str16", UserName: "str16",
  });
  const kernel = koffi.load("kernel32.dll");
  return { credential,
    write: lib.func("__stdcall", "CredWriteW", "int", [koffi.pointer(credential), "uint32_t"]),
    read: lib.func("__stdcall", "CredReadW", "int", ["str16", "uint32_t", "uint32_t", koffi.out(koffi.pointer("void *"))]),
    remove: lib.func("__stdcall", "CredDeleteW", "int", ["str16", "uint32_t", "uint32_t"]),
    free: lib.func("__stdcall", "CredFree", "void", ["void *"]),
    error: kernel.func("uint32_t __stdcall GetLastError()"),
  };
}
function native() { return api ??= load(); }
const target = (id: string) => `FlowCode/ModelProvider/${ContractIdSchema.parse(id)}`;
export class WindowsCredentialVault implements CredentialVault {
  async write(id: string, secret: string): Promise<void> {
    const a = native(); const blob = Buffer.from(secret, "utf8");
    if (!blob.length || blob.length > 2500 || secret.includes("\0")) throw new Error("Invalid model credential size.");
    try {
      if (!a.write({ Flags: 0, Type: 1, TargetName: target(id), Comment: "FlowCode model provider", LastWritten: { low: 0, high: 0 },
        CredentialBlobSize: blob.length, CredentialBlob: blob, Persist: 2, AttributeCount: 0, Attributes: null,
        TargetAlias: null, UserName: "FlowCode" }, 0)) throw new Error("Windows Credential Manager could not save the model key.");
    } finally { blob.fill(0); }
  }
  async read(id: string): Promise<string | undefined> {
    const a = native(); const output: unknown[] = [null];
    if (!a.read(target(id), 1, 0, output)) {
      if (a.error() === 1168) return undefined;
      throw new Error("Windows Credential Manager could not read the model key.");
    }
    try {
      const c = koffi.decode(output[0], a.credential);
      if (!c.CredentialBlobSize || c.CredentialBlobSize > 2500) throw new Error("Invalid stored model credential.");
      return Buffer.from(koffi.decode(c.CredentialBlob, "uint8_t", c.CredentialBlobSize)).toString("utf8");
    } finally { a.free(output[0]); }
  }
  async remove(id: string): Promise<void> {
    const a = native(); if (!a.remove(target(id), 1, 0) && a.error() !== 1168)
      throw new Error("Windows Credential Manager could not remove the model key.");
  }
}
