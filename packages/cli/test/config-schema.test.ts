import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Ajv2020 } from "ajv/dist/2020.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  loadHostConfig,
  readConfigFileObject,
  TOOL_USE_SELECTORS,
} from "@sparkwright/host";
import { runCli } from "../src/cli.js";

// Guards against drift between schemas/config.schema.json and what the CLI
// actually emits (init scaffolds, `config example`) and what the host loader
// accepts. A new field added to the loader/templates but not the schema (or
// vice versa) trips one of these checks.

const schemasDir = fileURLToPath(new URL("../../../schemas/", import.meta.url));

function buildValidator() {
  // validateFormats:false — we are checking structure/keys, not string formats
  // like "uri"; ajv otherwise logs noisy "unknown format" warnings.
  const ajv = new Ajv2020({
    allErrors: true,
    strict: false,
    validateFormats: false,
  });
  // Register every sibling schema by $id so cross-file $refs resolve.
  for (const file of readdirSync(schemasDir)) {
    if (!file.endsWith(".schema.json")) continue;
    const schema = JSON.parse(readFileSync(join(schemasDir, file), "utf8"));
    if (schema.$id) ajv.addSchema(schema);
  }
  const configSchema = JSON.parse(
    readFileSync(join(schemasDir, "config.schema.json"), "utf8"),
  );
  return ajv.getSchema(configSchema.$id) ?? ajv.compile(configSchema);
}

function createOutputCapture() {
  let stdout = "";
  return {
    io: {
      stdout: {
        write(chunk: string | Uint8Array) {
          stdout += String(chunk);
          return true;
        },
      },
      stderr: {
        write() {
          return true;
        },
      },
      stdinIsTTY: false as const,
    },
    stdoutText: () => stdout,
  };
}

describe("config schema drift guard", () => {
  let xdg: string;
  let workspace: string;
  let prevXdg: string | undefined;

  beforeEach(async () => {
    xdg = await mkdtemp(join(tmpdir(), "sparkwright-schema-xdg-"));
    workspace = await mkdtemp(join(tmpdir(), "sparkwright-schema-ws-"));
    prevXdg = process.env.XDG_CONFIG_HOME;
    process.env.XDG_CONFIG_HOME = xdg;
  });

  afterEach(async () => {
    if (prevXdg === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = prevXdg;
    await rm(xdg, { recursive: true, force: true });
    await rm(workspace, { recursive: true, force: true });
  });

  it("init scaffolds validate against the schema and load without errors", async () => {
    const validate = buildValidator();

    const userOut = createOutputCapture();
    expect((await runCli(["init"], { io: userOut.io })).exitCode).toBe(0);
    const userConfig = (
      await readConfigFileObject(join(xdg, "sparkwright", "config.yaml"))
    ).value;
    await expect(
      readFile(join(xdg, "sparkwright", "config.yaml"), "utf8"),
    ).resolves.toContain("# yaml-language-server: $schema=file://");
    expect(validate(userConfig), JSON.stringify(validate.errors)).toBe(true);

    const projectOut = createOutputCapture();
    expect(
      (
        await runCli(["init", "--project"], {
          cwd: workspace,
          io: projectOut.io,
        })
      ).exitCode,
    ).toBe(0);
    const projectConfig = (
      await readConfigFileObject(join(workspace, ".sparkwright", "config.yaml"))
    ).value;
    await expect(
      readFile(join(workspace, ".sparkwright", "config.yaml"), "utf8"),
    ).resolves.toContain("# yaml-language-server: $schema=file://");
    expect(validate(projectConfig), JSON.stringify(validate.errors)).toBe(true);

    // The user template seeds the apiKey placeholder; the loader reports it as a
    // real run blocker only at model-resolution time, not as a schema error.
    const loaded = await loadHostConfig(workspace, {
      XDG_CONFIG_HOME: xdg,
    });
    expect(loaded.errors).toEqual([]);
  });

  it("every `config example` snippet validates and loads cleanly", async () => {
    const validate = buildValidator();
    const names = [
      "write",
      "sandbox",
      "run",
      "hooks",
      "verification",
      "mcp",
      "agent",
    ];

    for (const name of names) {
      const out = createOutputCapture();
      const result = await runCli(["config", "example", name], { io: out.io });
      expect(result.exitCode, `example ${name} exit`).toBe(0);
      const snippet = JSON.parse(out.stdoutText());

      expect(
        validate(snippet),
        `example ${name}: ${JSON.stringify(validate.errors)}`,
      ).toBe(true);

      // Round-trip through the loader: a snippet the schema accepts but the
      // loader rejects is drift we want to catch.
      const ws = await mkdtemp(join(tmpdir(), "sparkwright-schema-ex-"));
      try {
        await mkdir(join(ws, ".sparkwright"), { recursive: true });
        await writeFile(
          join(ws, ".sparkwright", "config.json"),
          JSON.stringify(snippet),
          "utf8",
        );
        const loaded = await loadHostConfig(ws, { XDG_CONFIG_HOME: xdg });
        expect(loaded.errors, `example ${name} load`).toEqual([]);
      } finally {
        await rm(ws, { recursive: true, force: true });
      }
    }
  });

  it("rejects removed root aliases and shell.sandbox", () => {
    const validate = buildValidator();

    expect(
      validate({
        model: "deterministic",
        accessMode: "ask",
        shell: { sandbox: { mode: "warn" } },
      }),
    ).toBe(false);
    expect(validate.errors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ instancePath: "" }),
        expect.objectContaining({ instancePath: "/shell" }),
      ]),
    );
  });

  it("selector enums in the schemas stay in sync with TOOL_USE_SELECTORS", () => {
    // config.schema.json is generated from the zod source (which derives the
    // enum from TOOL_USE_SELECTORS), but agent-profile.schema.json is
    // hand-maintained and duplicates the same enum. This guard keeps both from
    // drifting out of sync with the single source-of-truth constant.
    const canonical = [...TOOL_USE_SELECTORS];
    const found: { file: string; values: string[] }[] = [];
    const visit = (node: unknown, file: string): void => {
      if (Array.isArray(node)) {
        for (const entry of node) visit(entry, file);
        return;
      }
      if (node && typeof node === "object") {
        const obj = node as Record<string, unknown>;
        if (
          Array.isArray(obj.enum) &&
          (obj.enum as unknown[]).includes("workspace.read")
        ) {
          found.push({ file, values: obj.enum as string[] });
        }
        for (const value of Object.values(obj)) visit(value, file);
      }
    };
    for (const file of ["config.schema.json", "agent-profile.schema.json"]) {
      visit(JSON.parse(readFileSync(join(schemasDir, file), "utf8")), file);
    }
    // Both schemas must carry the selector enum.
    expect(found.map((entry) => entry.file)).toEqual(
      expect.arrayContaining([
        "config.schema.json",
        "agent-profile.schema.json",
      ]),
    );
    for (const entry of found) {
      expect(entry.values, `${entry.file} selector enum drift`).toEqual(
        canonical,
      );
    }
  });

  it("agents model defaults validate as raw model refs", () => {
    const validate = buildValidator();

    expect(
      validate({
        capabilities: {
          agents: {
            spawnModel: "openai/gpt-5.4-mini",
            delegateModel: "anthropic/claude-sonnet-4-6",
          },
        },
      }),
      JSON.stringify(validate.errors),
    ).toBe(true);

    expect(
      validate({
        capabilities: {
          agents: {
            spawnModel: "",
            delegateModel: 123,
          },
        },
      }),
    ).toBe(false);
    expect(validate.errors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          instancePath: "/capabilities/agents/spawnModel",
        }),
        expect.objectContaining({
          instancePath: "/capabilities/agents/delegateModel",
        }),
      ]),
    );
  });

  it("the repository's own project config validates against the schema", async () => {
    const validate = buildValidator();
    const repoRoot = dirname(schemasDir.replace(/\/$/, ""));
    const projectConfigPath = [
      join(repoRoot, ".sparkwright", "config.json"),
      join(repoRoot, ".sparkwright", "config_test.json"),
    ].find((path) => existsSync(path));
    if (!projectConfigPath) return;
    const repoConfig = JSON.parse(await readFile(projectConfigPath, "utf8"));
    expect(validate(repoConfig), JSON.stringify(validate.errors)).toBe(true);
  });
});
