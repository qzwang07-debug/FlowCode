import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { BlueprintV2Shape } from "../../common/blueprint-v2";
import {
  BrowserCapabilitiesSchema,
  BrowserEnvironmentProfileSchema,
  BrowserSessionLeaseSchema,
  BrowserSourceIdentitySchema,
} from "../../common/browser-environment";
import {
  ProjectTargetSchema,
  ProjectContextSchema,
  ProjectRunRequestV2Schema,
  ConfirmationRecordSchema,
  RunCheckpointSchema,
  RecordingSourceStateSchema,
  AgentRunStateV2Schema,
  ProjectRunStateV2Schema,
} from "../../common/project-execution";
import { sealBlueprint } from "../../electron/evidence/blueprint-contract";
import { fixtureBlueprintV2 } from "./contract-fixtures";

const root = path.resolve("fixtures/stage5a");
await mkdir(root, { recursive: true });
const write = async (file: string, value: unknown) => {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify(value, null, 2) + "\n");
};
const schemas = {
  "blueprint-v2": BlueprintV2Shape,
  "browser-capabilities-v1": BrowserCapabilitiesSchema,
  "browser-environment-v1": BrowserEnvironmentProfileSchema,
  "browser-lease-v1": BrowserSessionLeaseSchema,
  "browser-source-v2": BrowserSourceIdentitySchema,
  "project-target-v1": ProjectTargetSchema,
  "project-context-v1": ProjectContextSchema,
  "run-request-v2": ProjectRunRequestV2Schema,
  "confirmation-v1": ConfirmationRecordSchema,
  "checkpoint-v1": RunCheckpointSchema,
  "recording-source-state-v1": RecordingSourceStateSchema,
  "agent-run-state-v2": AgentRunStateV2Schema,
  "project-run-state-v2": ProjectRunStateV2Schema,
};
for (const [name, schema] of Object.entries(schemas)) {
  await write(path.join(root, "schemas", `${name}.schema.json`), {
    ...z.toJSONSchema(schema),
    $comment:
      "Structural interchange schema. Host MUST additionally run the corresponding Zod graph/refinement validator and Blueprint content-hash verifier; this JSON Schema alone does not establish execution readiness or privacy.",
  });
}
await write(
  path.join(root, "blueprint-v2.json"),
  sealBlueprint(fixtureBlueprintV2()),
);
if (process.argv.includes("--capture-evidence")) {
  const evidence = path.join(root, "evidence");
  for (const name of [
    "opencode-smoke",
    "opencode-config",
    "windows-isolation",
    "ziniao-browser",
    "ziniao-manual-capture",
    "ziniao-artifacts",
    "ziniao-cli",
  ]) {
    const value = JSON.parse(
      await readFile(path.resolve(`.stage5a/evidence/${name}.json`), "utf8"),
    );
    const sanitize = (v: unknown): unknown =>
      typeof v === "string"
        ? v.replaceAll(path.resolve(".stage5a/opencode-smoke"), "<probe-root>")
        : Array.isArray(v)
          ? v.map(sanitize)
          : v && typeof v === "object"
            ? Object.fromEntries(
                Object.entries(v).map(([k, x]) => [k, sanitize(x)]),
              )
            : v;
    await write(path.join(evidence, `${name}.json`), sanitize(value));
  }
  // Keep the complete actual /doc response, not a hand-written approximation.
  const raw = await readFile(
    path.resolve(".stage5a/evidence/opencode-openapi.json"),
  );
  await write(
    path.join(root, "opencode-1.18.29.openapi.json"),
    JSON.parse(raw.toString("utf8")),
  );
  await write(path.join(evidence, "openapi-provenance.json"), {
    schemaVersion: 1,
    version: "1.18.29",
    endpoint: "GET /doc",
    rawCaptureSha256: createHash("sha256").update(raw).digest("hex"),
    completePaths: Object.keys(JSON.parse(raw.toString("utf8")).paths).length,
  });
}
console.log(
  "Stage 5A structural schemas and fixtures written. Real evidence is copied only with --capture-evidence.",
);
