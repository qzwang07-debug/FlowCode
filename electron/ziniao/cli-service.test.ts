import assert from "node:assert/strict";
import test from "node:test";
import {
  ZiniaoCliService,
  ZiniaoCliError,
  StoreListResponseSchema,
  StoreResolveResponseSchema,
  StoreStateResponseSchema,
  ziniaoReadArgs,
  parseAccountReference,
  createZiniaoTransport,
} from "./cli-service";
import { splitWindowsCommandLine } from "./windows-command-line";

const response = {
  ok: true,
  data: {
    matched: true,
    matchedBy: "name",
    name: "Fixture store",
    platformName: "fixture",
    storeId: "fixture-store",
  },
};
test("Ziniao command-specific schemas strip unrelated data and reject failures/unknown shapes", () => {
  const list = {
    ok: true,
    data: {
      items: [
        {
          storeId: "one",
          storeName: "Fixture store",
          platformName: "fixture",
          ip: "never-retain",
          token: "never-retain",
        },
      ],
      limit: 1,
      page: 1,
      total: 2,
    },
  };
  assert.equal(
    JSON.stringify(StoreListResponseSchema.parse(list)).includes(
      "never-retain",
    ),
    false,
  );
  assert.equal(
    StoreResolveResponseSchema.safeParse({
      ...response,
      data: { ...response.data, matched: false },
    }).success,
    false,
  );
  assert.equal(
    StoreStateResponseSchema.safeParse({
      ok: true,
      data: { running: false, storeId: "one", downloadFolderPath: null },
    }).success,
    true,
  );
  for (const schema of [
    StoreListResponseSchema,
    StoreResolveResponseSchema,
    StoreStateResponseSchema,
  ]) {
    assert.equal(
      schema.safeParse({ ok: false, data: response.data }).success,
      false,
    );
    assert.equal(
      schema.safeParse({ ok: true, data: { data: response.data } }).success,
      false,
    );
  }
});
test("Ziniao service verifies exact identity and detects external account switching", async () => {
  let account = "* fixture-account",
    resolved = response;
  const calls: string[][] = [];
  const service = new ZiniaoCliService(async (args) => {
    calls.push([...args]);
    return args[0] === "config"
      ? account
      : args[1] === "list"
        ? JSON.stringify({
            ok: true,
            data: {
              items: [
                {
                  storeId: "fixture-store",
                  storeName: "Fixture store",
                  platformName: "fixture",
                },
              ],
              page: 1,
              limit: 100,
              total: 1,
            },
          })
        : JSON.stringify(resolved);
  });
  const binding = await service.bindName("Fixture store");
  await service.verifyBinding(binding);
  assert.equal(binding.accountRef, parseAccountReference(account));
  account = "* different-account";
  await assert.rejects(service.verifyBinding(binding), /account-changed/);
  account = "* fixture-account";
  resolved = {
    ...response,
    data: { ...response.data, storeId: "wrong-store" },
  };
  await assert.rejects(service.verifyBinding(binding), /store-mismatch/);
  resolved = {
    ...response,
    data: { ...response.data, name: "duplicate or renamed" },
  };
  await assert.rejects(service.bindName("Fixture store"), /store-mismatch/);
  assert.ok(
    calls.every(
      (args) =>
        !["api", "exec", "invoke", "use", "close"].some((x) =>
          args.includes(x),
        ),
    ),
  );
});
test("authoritative list rejects CLI expected-name echo, duplicates and same-label config changes", async () => {
  let config = "a".repeat(64),
    duplicate = false;
  const service = new ZiniaoCliService(
    async (args) => {
      if (args[0] === "config") return "* fixture-profile";
      if (args[1] === "list") {
        const items = [
          {
            storeId: "fixture-store",
            storeName: "Fixture store",
            platformName: "fixture",
          },
        ];
        if (duplicate) items.push({ ...items[0], storeId: "second-store" });
        return JSON.stringify({
          ok: true,
          data: { items, page: 1, limit: 100, total: items.length },
        });
      }
      return JSON.stringify({
        ...response,
        data: {
          ...response.data,
          name: args[args.indexOf("--expected-name") + 1],
        },
      });
    },
    async () => config,
  );
  const bound = await service.bindName("Fixture store");
  await assert.rejects(
    service.verifyBinding({ ...bound, expectedName: "Wrong but echoed" }),
    /store-mismatch/,
  );
  config = "b".repeat(64);
  await assert.rejects(service.verifyBinding(bound), /account-changed/);
  duplicate = true;
  await assert.rejects(service.bindName("Fixture store"), /store-mismatch/);
});
test("CLI whitelist rejects arbitrary script/tool/paths and keeps metacharacters as one argument", () => {
  assert.deepEqual(
    ziniaoReadArgs({ kind: "resolve-name", name: "A & B; $(not-shell)" }).slice(
      2,
      6,
    ),
    ["--name", "A & B; $(not-shell)", "--expected-name", "A & B; $(not-shell)"],
  );
  assert.throws(() =>
    ziniaoReadArgs({ kind: "exec", script: "anything" } as never),
  );
  assert.throws(() => parseAccountReference("* one\n* two"));
  assert.throws(() => parseAccountReference("no active profile"));
  assert.equal(new ZiniaoCliError("timed-out", true).requiresStateCheck, true);
});
test("real subprocess transport enforces timeout/cancellation without leaking stderr or arguments", async () => {
  const transport = createZiniaoTransport(process.execPath);
  await assert.rejects(
    transport(
      ["-e", "console.error('canary-do-not-log');setTimeout(()=>{},10000)"],
      { timeoutMs: 100 },
    ),
    (error) =>
      error instanceof ZiniaoCliError &&
      error.code === "timed-out" &&
      !error.message.includes("canary"),
  );
  const controller = new AbortController();
  setTimeout(() => controller.abort(), 100);
  await assert.rejects(
    transport(["-e", "setTimeout(()=>{},10000)"], {
      signal: controller.signal,
      timeoutMs: 2000,
    }),
    (error) => error instanceof ZiniaoCliError && error.code === "canceled",
  );
});
test("Windows process argument parsing distinguishes exact profile IDs from prefixes", () => {
  assert.deepEqual(
    splitWindowsCommandLine(
      '"C:\\Browser Dir\\browser.exe" --user-data-dir="C:\\Profiles\\123" --flag',
    ),
    [
      "C:\\Browser Dir\\browser.exe",
      "--user-data-dir=C:\\Profiles\\123",
      "--flag",
    ],
  );
  assert.throws(() => splitWindowsCommandLine('"unterminated'));
});
