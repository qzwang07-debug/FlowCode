import type { Locator, Page } from "@playwright/test";

export class ExamplePage {
  readonly heading: Locator;

  constructor(readonly page: Page) {
    this.heading = page.getByRole("heading", { level: 1 });
  }

  async open(url: string): Promise<void> {
    await this.page.goto(url);
  }
}
