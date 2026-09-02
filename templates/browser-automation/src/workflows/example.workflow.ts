import type { Page } from "@playwright/test";
import { z } from "zod";

export const inputSchema = z.object({
  url: z.string().url(),
});

export type ExampleWorkflowInput = z.infer<typeof inputSchema>;

export const metadata = {
  id: "example",
  title: "Open a page",
  description: "Open a URL and return the page title.",
} as const;

export async function run(page: Page, input: ExampleWorkflowInput): Promise<{ title: string }> {
  const validated = inputSchema.parse(input);
  await page.goto(validated.url);
  return { title: await page.title() };
}
