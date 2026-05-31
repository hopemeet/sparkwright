import { chmodSync } from "node:fs";

const file = process.argv[2];

if (!file) {
  console.error("usage: node scripts/chmod-bin.mjs <file>");
  process.exit(2);
}

try {
  chmodSync(file, 0o755);
} catch (error) {
  if (process.platform !== "win32") {
    throw error;
  }
}
