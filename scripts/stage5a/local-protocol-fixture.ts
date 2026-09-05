import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { randomBytes } from "node:crypto";
import { z } from "zod";

export const ProbeResultSchema = z
  .object({
    schemaVersion: z.literal(1),
    sessionRef: z.literal("fixture-session"),
    observed: z.literal("restricted-mcp-called"),
    count: z.literal(1),
  })
  .strict();
export const probeResult = ProbeResultSchema.parse({
  schemaVersion: 1,
  sessionRef: "fixture-session",
  observed: "restricted-mcp-called",
  count: 1,
});
const RpcSchema = z
  .object({
    jsonrpc: z.literal("2.0"),
    id: z.union([z.string(), z.number()]).optional(),
    method: z.string(),
    params: z.unknown().optional(),
  })
  .strict();
const ToolCallSchema = z
  .object({
    name: z.literal("read_fixture"),
    arguments: z.object({ sessionRef: z.literal("fixture-session") }).strict(),
    _meta: z.record(z.string(), z.unknown()).optional(),
  })
  .strict();
async function body(req: IncomingMessage) {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const b of req) {
    size += b.length;
    if (size > 1024 * 1024) throw new Error("Oversize fixture request.");
    chunks.push(b);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}
function json(res: ServerResponse, status: number, value: unknown) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(value));
}

/** A deterministic local provider exercises the REAL OpenCode tool loop without
 * model cost or cloud data transfer. It is not a model quality/eval result.
 */
export async function startProtocolFixture() {
  const token = randomBytes(32).toString("hex");
  const calls: string[] = [],
    advertisedTools: string[][] = [],
    methods: string[] = [];
  let providerTurns = 0;
  const server = createServer(async (req, res) => {
    try {
      if (req.url === "/mcp") {
        if (req.headers.authorization !== `Bearer ${token}`)
          return json(res, 401, { error: "unauthorized" });
        if (req.method !== "POST") {
          res.writeHead(405);
          return res.end();
        }
        const rpc = RpcSchema.parse(await body(req));
        methods.push(rpc.method);
        if (rpc.id === undefined) {
          res.writeHead(202);
          return res.end();
        }
        let result: unknown;
        if (rpc.method === "initialize")
          result = {
            protocolVersion: "2025-03-26",
            capabilities: { tools: {} },
            serverInfo: { name: "flowcode-stage5a-fixture", version: "1.0.0" },
          };
        else if (rpc.method === "tools/list")
          result = {
            tools: [
              {
                name: "read_fixture",
                description: "Read only the fixed synthetic session.",
                inputSchema: {
                  type: "object",
                  properties: {
                    sessionRef: { type: "string", const: "fixture-session" },
                  },
                  required: ["sessionRef"],
                  additionalProperties: false,
                },
              },
            ],
          };
        else if (rpc.method === "tools/call") {
          const call = ToolCallSchema.safeParse(rpc.params);
          if (!call.success) {
            console.error(
              "Synthetic MCP call rejected",
              JSON.stringify(rpc.params),
            );
            return json(res, 200, {
              jsonrpc: "2.0",
              id: rpc.id,
              error: { code: -32602, message: "Outside fixture scope." },
            });
          }
          calls.push(call.data.name);
          result = {
            content: [{ type: "text", text: JSON.stringify(probeResult) }],
            isError: false,
          };
        } else if (rpc.method === "ping") result = {};
        else
          return json(res, 200, {
            jsonrpc: "2.0",
            id: rpc.id,
            error: { code: -32601, message: "Method not allowed." },
          });
        return json(res, 200, { jsonrpc: "2.0", id: rpc.id, result });
      }
      if (req.url?.endsWith("/chat/completions")) {
        const input = await body(req);
        const tools = (input.tools ?? [])
          .map((t: { function?: { name?: string } }) => t.function?.name)
          .filter(Boolean) as string[];
        advertisedTools.push(tools);
        providerTurns++;
        if (providerTurns > 6)
          return json(res, 400, {
            error: { message: "Fixture turn limit exceeded." },
          });
        const mcpName = tools.find((n) => n.endsWith("read_fixture"));
        const structured = tools.find((n) => n === "StructuredOutput");
        const name = calls.length === 0 ? mcpName : structured;
        if (!name)
          return json(res, 400, {
            error: {
              message: "Expected tool absent from real OpenCode request.",
            },
          });
        const args =
          name === "StructuredOutput"
            ? probeResult
            : { sessionRef: "fixture-session" };
        res.writeHead(200, {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
        });
        const chunk = (delta: unknown, finish_reason: string | null = null) =>
          res.write(
            `data: ${JSON.stringify({ id: `chatcmpl-fixture-${providerTurns}`, object: "chat.completion.chunk", created: 1, model: "probe", choices: [{ index: 0, delta, finish_reason }] })}\n\n`,
          );
        chunk({
          role: "assistant",
          tool_calls: [
            {
              index: 0,
              id: `call-fixture-${providerTurns}`,
              type: "function",
              function: { name, arguments: JSON.stringify(args) },
            },
          ],
        });
        chunk({}, "tool_calls");
        res.end("data: [DONE]\n\n");
        return;
      }
      json(res, 404, { error: "Not a fixture endpoint." });
    } catch {
      json(res, 400, { error: "Invalid fixture request." });
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  return {
    url,
    token,
    calls,
    methods,
    advertisedTools,
    get providerTurns() {
      return providerTurns;
    },
    stop: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
