import { z } from "zod";
export const OPENCODE_PIN = "1.18.29";
export const OpenCodeHealthSchema = z
  .object({ healthy: z.literal(true), version: z.literal(OPENCODE_PIN) })
  .strict();
export const OpenCodeSessionSchema = z
  .object({ id: z.string().regex(/^ses_[A-Za-z0-9]+$/) })
  .passthrough();
export const OpenCodePromptSchema = z
  .object({
    model: z
      .object({ providerID: z.string().min(1), modelID: z.string().min(1) })
      .strict(),
    agent: z.string().min(1),
    parts: z
      .array(
        z
          .object({ type: z.literal("text"), text: z.string().max(65536) })
          .strict(),
      )
      .min(1)
      .max(20),
    format: z
      .object({
        type: z.literal("json_schema"),
        schema: z.record(z.string(), z.unknown()),
        retryCount: z.number().int().min(0).max(3),
      })
      .strict(),
  })
  .strict();

/** Fixed OpenAPI contract client for 5A probes. No credentials in URLs or errors. */
export class OpenCodeContractClient {
  constructor(
    private readonly base: string,
    private readonly username: string,
    private readonly password: string,
    private readonly timeoutMs = 60000,
  ) {
    const url = new URL(base);
    if (
      url.protocol !== "http:" ||
      url.hostname !== "127.0.0.1" ||
      !url.port ||
      url.pathname !== "/" ||
      url.search ||
      url.hash ||
      url.username ||
      url.password
    )
      throw new Error("OpenCode probe must use an exact loopback origin.");
  }
  async request(route: string, body?: unknown): Promise<unknown> {
    if (
      !route.startsWith("/") ||
      route.startsWith("//") ||
      route.includes("\\") ||
      new URL(route, this.base).origin !== this.base
    )
      throw new Error("Invalid probe route.");
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await fetch(this.base + route, {
        method: body === undefined ? "GET" : "POST",
        headers: {
          Authorization: `Basic ${Buffer.from(`${this.username}:${this.password}`).toString("base64")}`,
          "Content-Type": "application/json",
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: controller.signal,
        redirect: "error",
      });
      if (!response.ok) {
        await response.body?.cancel();
        throw new Error(`OpenCode request failed (HTTP ${response.status}).`);
      }
      if (!response.body)
        throw new Error("OpenCode returned no response body.");
      const reader = response.body.getReader();
      const chunks: Uint8Array[] = [];
      let size = 0;
      try {
        while (true) {
          const chunk = await reader.read();
          if (chunk.done) break;
          size += chunk.value.length;
          if (size > 8 * 1024 * 1024)
            throw new Error("OpenCode response exceeds probe limit.");
          chunks.push(chunk.value);
        }
      } finally {
        await reader.cancel().catch(() => {});
      }
      try {
        return JSON.parse(Buffer.concat(chunks).toString("utf8"));
      } catch {
        throw new Error("OpenCode returned malformed JSON.");
      }
    } finally {
      clearTimeout(timer);
    }
  }
  async health() {
    return OpenCodeHealthSchema.parse(await this.request("/global/health"));
  }
  async createSession(title: string) {
    return OpenCodeSessionSchema.parse(
      await this.request("/session", {
        title: z.string().min(1).max(256).parse(title),
      }),
    );
  }
  async prompt(sessionId: string, input: z.infer<typeof OpenCodePromptSchema>) {
    const id = OpenCodeSessionSchema.parse({ id: sessionId }).id;
    return this.request(
      `/session/${id}/message`,
      OpenCodePromptSchema.parse(input),
    );
  }
}
