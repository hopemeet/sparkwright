// Repo Pilot golden-path validator.
//
// Repo Pilot is a documentation-first validation example: its contract lives in
// README.md (the Sparkwright CLI "golden path"). This script asserts that the
// README still documents that contract so the example cannot silently drift
// away from the commands it promises. It is intentionally dependency-free
// (node built-ins only) so `npm run build`/`typecheck`/`test` stay fast and
// hermetic.
//
//   npm run golden-path     # full golden path (mentions --write)
//   npm run smoke           # read-only variant (passes --readonly)

import { readFile } from "node:fs/promises";
import { join } from "node:path";

/** Tokens every golden-path README must mention, by mode. */
const COMMON_TOKENS = ["--workspace", "--target README.md", "trace.jsonl"];
const WRITE_TOKENS = ["--write", "approval"];

async function main(): Promise<void> {
  const readonly = process.argv.includes("--readonly");
  // npm runs scripts with cwd = this package directory, so the README is here
  // whether we run from source or from the compiled dist/.
  const readmePath = join(process.cwd(), "README.md");
  const readme = await readFile(readmePath, "utf8");

  const required = readonly
    ? COMMON_TOKENS
    : [...COMMON_TOKENS, ...WRITE_TOKENS];
  const missing = required.filter((token) => !readme.includes(token));
  if (missing.length > 0) {
    console.error(
      `Repo Pilot README is missing golden-path token(s): ${missing.join(", ")}`,
    );
    process.exitCode = 1;
    return;
  }

  console.log(
    `Repo Pilot golden-path README invariants OK${readonly ? " (read-only)" : ""}.`,
  );
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
