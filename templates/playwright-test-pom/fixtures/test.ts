import { test as base } from "@playwright/test";

import { ExamplePage } from "../pages/example.page.js";

interface Fixtures {
  examplePage: ExamplePage;
}

export const test = base.extend<Fixtures>({
  examplePage: async ({ page }, use) => {
    await use(new ExamplePage(page));
  },
});

export { expect } from "@playwright/test";
