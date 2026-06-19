import { cp, mkdir, readdir, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sourceDir = path.join(root, "schemas");
const targetDir = path.join(root, "packages", "cli", "dist", "schemas");

await rm(targetDir, { recursive: true, force: true });
await mkdir(targetDir, { recursive: true });

const schemaFiles = (await readdir(sourceDir))
  .filter((file) => file.endsWith(".schema.json"))
  .sort();

for (const file of schemaFiles) {
  await cp(path.join(sourceDir, file), path.join(targetDir, file));
}
