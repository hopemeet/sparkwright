import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import type { OutboundTarget } from "./types.js";

interface StoreData {
  sessions: Record<string, string>;
  runTargets: Record<string, StoredTarget>;
  approvalRuns: Record<string, string>;
  processedMessages: Record<string, number>;
}

interface StoredTarget extends OutboundTarget {
  sessionKey: string;
}

export class GatewayStore {
  private data: StoreData = {
    sessions: {},
    runTargets: {},
    approvalRuns: {},
    processedMessages: {},
  };
  private loaded = false;

  constructor(private readonly path: string) {}

  async load(): Promise<void> {
    if (this.loaded) return;
    try {
      const raw = await readFile(this.path, "utf8");
      const parsed = JSON.parse(raw) as Partial<StoreData>;
      this.data = {
        sessions: parsed.sessions ?? {},
        runTargets: parsed.runTargets ?? {},
        approvalRuns: parsed.approvalRuns ?? {},
        processedMessages: parsed.processedMessages ?? {},
      };
    } catch {
      // Missing or corrupt state should not prevent the daemon from starting.
    }
    this.loaded = true;
  }

  async getOrCreateSessionId(sessionKey: string): Promise<string> {
    await this.load();
    const existing = this.data.sessions[sessionKey];
    if (existing) return existing;
    const created = `im_${randomUUID()}`;
    this.data.sessions[sessionKey] = created;
    await this.save();
    return created;
  }

  async rememberRun(
    runId: string,
    sessionKey: string,
    target: OutboundTarget,
  ): Promise<void> {
    await this.load();
    this.data.runTargets[runId] = { ...target, sessionKey };
    await this.save();
  }

  async targetForRun(runId: string): Promise<StoredTarget | undefined> {
    await this.load();
    return this.data.runTargets[runId];
  }

  async rememberApproval(approvalId: string, runId: string): Promise<void> {
    await this.load();
    this.data.approvalRuns[approvalId] = runId;
    await this.save();
  }

  async runForApproval(approvalId: string): Promise<string | undefined> {
    await this.load();
    return this.data.approvalRuns[approvalId];
  }

  async hasProcessedMessage(key: string): Promise<boolean> {
    await this.load();
    return Object.prototype.hasOwnProperty.call(
      this.data.processedMessages,
      key,
    );
  }

  async markProcessedMessage(key: string): Promise<void> {
    await this.load();
    this.data.processedMessages[key] = Date.now();
    const entries = Object.entries(this.data.processedMessages);
    if (entries.length > 2000) {
      entries
        .sort((a, b) => a[1] - b[1])
        .slice(0, entries.length - 2000)
        .forEach(([oldKey]) => delete this.data.processedMessages[oldKey]);
    }
    await this.save();
  }

  private async save(): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true });
    const tmp = `${this.path}.${process.pid}.tmp`;
    await writeFile(tmp, JSON.stringify(this.data, null, 2), "utf8");
    await rename(tmp, this.path);
  }
}
