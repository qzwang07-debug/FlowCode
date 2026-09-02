import { chromium } from "@playwright/test";

import { inputSchema, metadata, run } from "../workflows/example.workflow.js";

function argument(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function browserChannel(): "chrome" | "msedge" {
  const channel = argument("--browser") ?? process.env.FLOWCODE_BROWSER_CHANNEL ?? "chrome";
  if (channel !== "chrome" && channel !== "msedge") {
    throw new Error('Browser must be "chrome" or "msedge".');
  }
  return channel;
}

async function main(): Promise<void> {
  if (process.argv[2] !== "run") {
    console.log(
      `${metadata.title}: npm run workflow -- --url https://example.test --browser chrome`,
    );
    return;
  }

  const input = inputSchema.parse({ url: argument("--url") });
  const browser = await chromium.launch({ channel: browserChannel(), headless: true });
  try {
    const page = await browser.newPage();
    console.log(JSON.stringify(await run(page, input), null, 2));
  } finally {
    await browser.close();
  }
}

await main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
