import { expect, test } from "../fixtures/test.js";

test("the project is ready for an authored workflow", async ({ examplePage }) => {
  await examplePage.open("data:text/html,<h1>FlowCode project</h1>");
  await expect(examplePage.heading).toHaveText("FlowCode project");
});
