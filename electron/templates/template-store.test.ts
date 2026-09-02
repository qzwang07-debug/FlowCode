import assert from "node:assert/strict";
import {
  cp,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { TemplateStore, templateIntegrity } from "./template-store";

const realTemplatesRoot = path.resolve(
  import.meta.dirname,
  "..",
  "..",
  "templates",
);

test("both bundled templates pass manifest hashes and required-file validation", async () => {
  assert.equal(
    await readFile(path.join(realTemplatesRoot, ".gitattributes"), "utf8"),
    "* text=auto eol=lf\n",
  );
  const store = new TemplateStore(realTemplatesRoot);
  const templates = await store.list();
  assert.deepEqual(
    templates.map(({ id, kind }) => [id, kind]),
    [
      ["browser-automation", "browser-automation"],
      ["playwright-test-pom", "web-test"],
    ],
  );

  for (const manifest of templates) {
    assert.ok(manifest.files.some((file) => file.path === ".gitattributes"));
    await store.validate(manifest.id);
  }
});

test("materializing a template preserves every declared hash", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "flowcode-template-copy-"));
  try {
    const store = new TemplateStore(realTemplatesRoot);
    const destination = path.join(root, "project");
    const manifest = await store.materialize(
      "playwright-test-pom",
      destination,
    );
    await store.verifyMaterialized(manifest, destination);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("template lockfiles pin dependency graphs and every install script decision", async () => {
  const expectations = {
    "browser-automation": {
      "esbuild@0.28.2": true,
      "fsevents@2.3.2": false,
      "fsevents@2.3.3": false,
    },
    "playwright-test-pom": {
      "fsevents@2.3.2": false,
    },
  } as const;

  for (const [id, expectedScripts] of Object.entries(expectations)) {
    const directory = path.join(realTemplatesRoot, id);
    const packageJson = JSON.parse(
      await readFile(path.join(directory, "package.json"), "utf8"),
    ) as {
      dependencies?: Record<string, string>;
      devDependencies: Record<string, string>;
      allowScripts: Record<string, boolean>;
    };
    const lock = JSON.parse(
      await readFile(path.join(directory, "package-lock.json"), "utf8"),
    ) as {
      lockfileVersion: number;
      packages: Record<
        string,
        {
          name?: string;
          version?: string;
          dependencies?: Record<string, string>;
          devDependencies?: Record<string, string>;
          hasInstallScript?: boolean;
        }
      >;
    };

    assert.equal(lock.lockfileVersion, 3);
    assert.deepEqual(lock.packages[""]?.dependencies, packageJson.dependencies);
    assert.deepEqual(
      lock.packages[""]?.devDependencies,
      packageJson.devDependencies,
    );
    for (const version of [
      ...Object.values(packageJson.dependencies ?? {}),
      ...Object.values(packageJson.devDependencies),
    ]) {
      assert.match(version, /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/);
    }

    const scriptPackages = Object.entries(lock.packages)
      .filter(([, entry]) => entry.hasInstallScript)
      .map(([packagePath, entry]) => {
        const name = entry.name ?? packagePath.split("node_modules/").at(-1);
        return `${name}@${entry.version}`;
      })
      .sort();
    assert.deepEqual(scriptPackages, Object.keys(expectedScripts).sort());
    assert.deepEqual(packageJson.allowScripts, expectedScripts);
  }
});

test("template validation rejects changed and missing required files", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "flowcode-template-tamper-"));
  try {
    const copiedTemplates = path.join(root, "templates");
    await cp(realTemplatesRoot, copiedTemplates, { recursive: true });
    const store = new TemplateStore(copiedTemplates);
    const packageFile = path.join(
      copiedTemplates,
      "playwright-test-pom",
      "package.json",
    );
    const originalPackage = await readFile(packageFile, "utf8");

    await writeFile(packageFile, `${originalPackage}\n`, "utf8");
    await assert.rejects(store.validate("playwright-test-pom"), /SHA-256/i);

    await writeFile(packageFile, originalPackage, "utf8");
    await rm(path.join(copiedTemplates, "playwright-test-pom", "README.md"));
    await assert.rejects(
      store.validate("playwright-test-pom"),
      /missing required file/i,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("template validation rejects symbolic-link escape", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "flowcode-template-link-"));
  try {
    const templateRoot = path.join(root, "templates", "unsafe-template");
    const outside = path.join(root, "outside");
    await mkdir(templateRoot, { recursive: true });
    await mkdir(outside);
    const contents = "outside\n";
    await writeFile(path.join(outside, "secret.txt"), contents, "utf8");
    try {
      await symlink(
        outside,
        path.join(templateRoot, "linked"),
        process.platform === "win32" ? "junction" : "dir",
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EPERM") {
        t.skip("This Windows environment does not permit creating links.");
        return;
      }
      throw error;
    }

    const files = [
      {
        path: "linked/secret.txt",
        sha256: createHash("sha256").update(contents).digest("hex"),
        required: true,
      },
    ];
    await writeFile(
      path.join(templateRoot, "template.json"),
      JSON.stringify(
        {
          schemaVersion: 1,
          id: "unsafe-template",
          version: "1.0.0",
          kind: "web-test",
          name: "Unsafe",
          description: "Unsafe test template",
          files,
          integrity: { algorithm: "sha256", value: templateIntegrity(files) },
        },
        null,
        2,
      ),
      "utf8",
    );

    await assert.rejects(
      new TemplateStore(path.join(root, "templates")).validate(
        "unsafe-template",
      ),
      /symbolic link/i,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
