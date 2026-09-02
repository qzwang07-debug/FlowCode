import type { Page } from "@playwright/test";

export class ExamplePage {
  constructor(readonly page: Page) {}

  async title(): Promise<string> {
    return this.page.title();
  }
}
