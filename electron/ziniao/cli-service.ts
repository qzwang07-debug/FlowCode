import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createHash } from "node:crypto";
import { readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { ZiniaoStoreBindingSchema } from "../../common/browser-environment";

export const ZINIAO_CLI_VERSION = "1.0.8";
export const ZINIAO_CLI_WINDOWS_SHA256 =
  "4e838532dbcf791b2dc5295a36a70980c0450999f87abaff78c24338bf83c548";
const StoreId = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,191}$/);
const Name = z
  .string()
  .trim()
  .min(1)
  .max(256)
  .refine((s) => !s.includes("\0"));
const ItemSchema = z
  .object({
    storeId: StoreId,
    storeName: Name,
    platformName: z.string().max(256),
  })
  .strip();
export const StoreListResponseSchema = z
  .object({
    ok: z.literal(true),
    data: z
      .object({
        items: z.array(ItemSchema).max(1000),
        limit: z.number().int().positive().max(1000),
        page: z.number().int().positive(),
        total: z.number().int().nonnegative(),
      })
      .strip(),
  })
  .strip()
  .refine(
    (v) =>
      v.data.items.length <= v.data.limit &&
      v.data.items.length <= v.data.total,
    "Inconsistent pagination.",
  );
export const StoreResolveResponseSchema = z
  .object({
    ok: z.literal(true),
    data: z
      .object({
        matched: z.literal(true),
        matchedBy: z.string().min(1).max(32),
        name: Name,
        platformName: z.string().max(256),
        storeId: StoreId,
      })
      .strip(),
  })
  .strip();
export const StoreStateResponseSchema = z
  .object({
    ok: z.literal(true),
    data: z
      .object({
        running: z.boolean(),
        storeId: StoreId,
        storeName: Name.optional(),
        downloadFolderPath: z.string().max(32767).nullable().optional(),
      })
      .strip(),
  })
  .strip();
export const ZiniaoReadRequestSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("list"),
      page: z.number().int().positive(),
      limit: z.number().int().min(1).max(100),
      keyword: Name.optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("resolve-id"),
      storeId: StoreId,
      expectedName: Name,
    })
    .strict(),
  z.object({ kind: z.literal("resolve-name"), name: Name }).strict(),
  z.object({ kind: z.literal("state"), storeId: StoreId }).strict(),
]);
export class ZiniaoCliError extends Error {
  constructor(
    readonly code:
      | "unavailable"
      | "unsupported-version"
      | "invalid-response"
      | "account-changed"
      | "store-mismatch"
      | "canceled"
      | "timed-out"
      | "command-failed",
    readonly requiresStateCheck = false,
  ) {
    super(
      `Ziniao CLI: ${code}${requiresStateCheck ? "; query the selected store state before retrying" : ""}.`,
    );
  }
}
export interface CliTransport {
  (
    args: readonly string[],
    options: { signal?: AbortSignal; timeoutMs: number },
  ): Promise<string>;
}
const exec = promisify(execFile);
export async function detectZiniaoCli(binaryPath: string) {
  const binary = await realpath(binaryPath);
  if (
    !path.isAbsolute(binary) ||
    (process.platform === "win32" &&
      path.basename(binary).toLowerCase() !== "ziniao-cli.exe")
  )
    throw new ZiniaoCliError("unavailable");
  const version = (
    await exec(binary, ["--version"], {
      shell: false,
      windowsHide: true,
      timeout: 10000,
      maxBuffer: 4096,
    })
  ).stdout.trim();
  const sha256 = createHash("sha256")
    .update(await readFile(binary))
    .digest("hex");
  if (
    version !== `ziniao-cli version ${ZINIAO_CLI_VERSION}` ||
    (process.platform === "win32" && sha256 !== ZINIAO_CLI_WINDOWS_SHA256)
  )
    throw new ZiniaoCliError("unsupported-version");
  return { binary, version: ZINIAO_CLI_VERSION, sha256 };
}
export function createZiniaoTransport(binary: string): CliTransport {
  return async (args, options) => {
    try {
      return (
        await exec(binary, [...args], {
          shell: false,
          windowsHide: true,
          encoding: "utf8",
          signal: options.signal,
          timeout: options.timeoutMs,
          maxBuffer: 1024 * 1024,
        })
      ).stdout;
    } catch (error) {
      const code = options.signal?.aborted
        ? "canceled"
        : (error as { killed?: boolean; code?: string }).killed ||
            (error as { code?: string }).code === "ETIMEDOUT"
          ? "timed-out"
          : "command-failed";
      throw new ZiniaoCliError(code, args[0] === "store" && args[1] === "open");
    }
  };
}
export function parseAccountReference(raw: string): string {
  const active = raw.split(/\r?\n/).filter((l) => /^\s*\*\s+\S/.test(l));
  if (active.length !== 1) throw new ZiniaoCliError("invalid-response");
  const name = Name.parse(active[0].replace(/^\s*\*\s+/, "").trim());
  return createHash("sha256")
    .update(`ziniao-cli-config-v1\0${name}`)
    .digest("hex");
}
/** Hash the actual local config bytes without returning or logging their contents.
 * This also invalidates bindings when credentials/config change under the same label.
 * The caller supplies the detected config path; no path is accepted from Renderer.
 */
export function ziniaoConfigFingerprint(
  configPath: string,
): () => Promise<string> {
  return async () => {
    const raw = await readFile(await realpath(configPath));
    if (raw.byteLength > 1024 * 1024)
      throw new ZiniaoCliError("invalid-response");
    try {
      z.object({
        currentProfile: Name,
        profiles: z.record(z.string(), z.unknown()),
      }).parse(JSON.parse(raw.toString("utf8")));
    } catch {
      throw new ZiniaoCliError("invalid-response");
    }
    return createHash("sha256").update(raw).digest("hex");
  };
}
function parse<T>(schema: z.ZodType<T>, text: string): T {
  try {
    return schema.parse(JSON.parse(text));
  } catch {
    throw new ZiniaoCliError("invalid-response");
  }
}
export function ziniaoReadArgs(
  input: z.infer<typeof ZiniaoReadRequestSchema>,
): string[] {
  const r = ZiniaoReadRequestSchema.parse(input);
  switch (r.kind) {
    case "list":
      return [
        "store",
        "list",
        "--page",
        String(r.page),
        "--limit",
        String(r.limit),
        ...(r.keyword ? ["--keyword", r.keyword] : []),
        "--format",
        "json",
      ];
    case "resolve-id":
      return [
        "store",
        "resolve",
        "--id",
        r.storeId,
        "--expected-name",
        r.expectedName,
        "--format",
        "json",
      ];
    case "resolve-name":
      return [
        "store",
        "resolve",
        "--name",
        r.name,
        "--expected-name",
        r.name,
        "--format",
        "json",
      ];
    case "state":
      return [
        "page",
        "extract",
        "--mode",
        "store",
        "--store-id",
        r.storeId,
        "--format",
        "json",
      ];
  }
}
/** Internal, typed service; no Renderer IPC, arbitrary zclaw, scripts or close-store API. */
export class ZiniaoCliService {
  constructor(
    private readonly transport: CliTransport,
    private readonly configFingerprint?: () => Promise<string>,
  ) {}
  async accountRef(signal?: AbortSignal) {
    const before = await this.configFingerprint?.();
    const profile = parseAccountReference(
      await this.transport(["config", "list"], { signal, timeoutMs: 10000 }),
    );
    const after = await this.configFingerprint?.();
    if (before !== after) throw new ZiniaoCliError("account-changed");
    return before
      ? createHash("sha256").update(`${profile}\0${before}`).digest("hex")
      : profile;
  }
  async list(page = 1, limit = 20, signal?: AbortSignal) {
    const r = parse(
      StoreListResponseSchema,
      await this.transport(ziniaoReadArgs({ kind: "list", page, limit }), {
        signal,
        timeoutMs: 30000,
      }),
    );
    if (r.data.page !== page || r.data.limit !== limit)
      throw new ZiniaoCliError("invalid-response");
    return r.data;
  }
  async bindName(name: string, signal?: AbortSignal) {
    const before = await this.accountRef(signal);
    const r = parse(
      StoreResolveResponseSchema,
      await this.transport(ziniaoReadArgs({ kind: "resolve-name", name }), {
        signal,
        timeoutMs: 30000,
      }),
    );
    if (r.data.name !== name) throw new ZiniaoCliError("store-mismatch");
    const matches = (await this.authoritativeStores(signal)).filter(
      (store) => store.storeName === name,
    );
    if (matches.length !== 1 || matches[0].storeId !== r.data.storeId)
      throw new ZiniaoCliError("store-mismatch");
    if (before !== (await this.accountRef(signal)))
      throw new ZiniaoCliError("account-changed");
    return ZiniaoStoreBindingSchema.parse({
      accountRef: before,
      storeId: r.data.storeId,
      expectedName: name,
    });
  }
  async verifyBinding(
    binding: z.infer<typeof ZiniaoStoreBindingSchema>,
    signal?: AbortSignal,
  ) {
    const b = ZiniaoStoreBindingSchema.parse(binding);
    if (b.accountRef !== (await this.accountRef(signal)))
      throw new ZiniaoCliError("account-changed");
    const r = parse(
      StoreResolveResponseSchema,
      await this.transport(
        ziniaoReadArgs({
          kind: "resolve-id",
          storeId: b.storeId,
          expectedName: b.expectedName,
        }),
        { signal, timeoutMs: 30000 },
      ),
    );
    if (r.data.storeId !== b.storeId || r.data.name !== b.expectedName)
      throw new ZiniaoCliError("store-mismatch");
    // CLI 1.0.8's resolve --id can echo expected-name instead of verifying it.
    // The paginated store list is independently checked; never trust that echo.
    const actual = (await this.authoritativeStores(signal)).find(
      (store) => store.storeId === b.storeId,
    );
    if (!actual || actual.storeName !== b.expectedName)
      throw new ZiniaoCliError("store-mismatch");
    if (b.accountRef !== (await this.accountRef(signal)))
      throw new ZiniaoCliError("account-changed");
  }
  async state(
    binding: z.infer<typeof ZiniaoStoreBindingSchema>,
    signal?: AbortSignal,
  ) {
    await this.verifyBinding(binding, signal);
    const r = parse(
      StoreStateResponseSchema,
      await this.transport(
        ziniaoReadArgs({ kind: "state", storeId: binding.storeId }),
        { signal, timeoutMs: 30000 },
      ),
    );
    if (
      r.data.storeId !== binding.storeId ||
      (r.data.storeName && r.data.storeName !== binding.expectedName)
    )
      throw new ZiniaoCliError("store-mismatch");
    if (binding.accountRef !== (await this.accountRef(signal)))
      throw new ZiniaoCliError("account-changed");
    return r.data;
  }
  private async authoritativeStores(signal?: AbortSignal) {
    const rows: Array<z.infer<typeof ItemSchema>> = [];
    let total: number | undefined;
    for (let page = 1; page <= 100; page++) {
      const current = await this.list(page, 100, signal);
      if (total !== undefined && total !== current.total)
        throw new ZiniaoCliError("invalid-response");
      total = current.total;
      rows.push(...current.items);
      if (new Set(rows.map((s) => s.storeId)).size !== rows.length)
        throw new ZiniaoCliError("invalid-response");
      if (rows.length === total) return rows;
      if (rows.length > total || current.items.length === 0)
        throw new ZiniaoCliError("invalid-response");
    }
    throw new ZiniaoCliError("invalid-response");
  }
}
