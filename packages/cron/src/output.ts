import { mkdir, open, rename } from "node:fs/promises";
import { join } from "node:path";

export interface CronOutputRecord {
  jobId: string;
  path: string;
  content: string;
}

export async function writeJobOutput(input: {
  rootDir: string;
  jobId: string;
  content: string;
  at?: Date;
}): Promise<CronOutputRecord> {
  const at = input.at ?? new Date();
  const dir = join(input.rootDir, "output", input.jobId);
  await mkdir(dir, { recursive: true });
  const stamp = at.toISOString().replace(/[:.]/g, "-");
  const path = join(dir, `${stamp}.md`);
  const tmp = `${path}.tmp`;
  const handle = await open(tmp, "w", 0o600);
  try {
    await handle.writeFile(input.content, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(tmp, path);
  return { jobId: input.jobId, path, content: input.content };
}
