import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Architectural guarantee: the browser SDK's compiled output must NOT
 * reference any Node built-ins. If a future change pulls in `node:fs`
 * or similar, this test fails — preventing the published browser bundle
 * from silently breaking in real browsers.
 *
 * We scan the emitted .js files; this is what would actually ship.
 */
const here = dirname(fileURLToPath(import.meta.url));

const FORBIDDEN_PATTERNS = [
  /from\s+["']node:/,
  /require\(["']node:/,
  /from\s+["']ws["']/, // node-only WS lib
  /from\s+["']child_process["']/,
  /from\s+["']fs["']/,
  /from\s+["']path["']/,
];

const FILES = ["../dist/index.js", "../dist/transport-ws.js"];

describe("@sparkwright/sdk-browser bundle", () => {
  it.each(FILES)("contains no Node-only imports: %s", async (rel) => {
    const path = join(here, rel);
    const src = await readFile(path, "utf8");
    for (const pat of FORBIDDEN_PATTERNS) {
      const match = pat.exec(src);
      expect(
        match,
        `forbidden import ${pat} in ${rel}: ${match?.[0]}`,
      ).toBeNull();
    }
  });
});
