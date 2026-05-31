// AI maintenance note: Durable SkillUsageRecorder. The interface is
// synchronous for matcher hot paths, so this implementation loads once at
// construction and performs small atomic JSON writes after mutations.

import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { dirname, resolve } from "node:path";
import {
  type SkillUsageRecord,
  type SkillUsageRecorder,
  type SkillUsageState,
} from "./usage.js";

export interface FileSkillUsageRecorderOptions {
  path: string;
  now?: () => Date;
}

interface UsageFile {
  schemaVersion: "skill-usage.v0.1";
  records: SkillUsageRecord[];
}

export class FileSkillUsageRecorder implements SkillUsageRecorder {
  private readonly path: string;
  private readonly byName = new Map<string, SkillUsageRecord>();

  constructor(options: FileSkillUsageRecorderOptions) {
    this.path = resolve(options.path);
    this.load();
  }

  recordUse(name: string, at?: Date): void {
    const r = this.ensure(name);
    r.useCount += 1;
    r.lastUsedAt = (at ?? new Date()).toISOString();
    if (r.state === "stale") r.state = "active";
    this.flush();
  }

  recordPatch(name: string, at?: Date): void {
    const r = this.ensure(name);
    r.patchCount += 1;
    r.lastPatchedAt = (at ?? new Date()).toISOString();
    this.flush();
  }

  markAgentCreated(name: string, metadata?: Record<string, unknown>): void {
    const r = this.ensure(name);
    r.agentCreated = true;
    if (metadata) r.metadata = { ...r.metadata, ...metadata };
    this.flush();
  }

  forget(name: string): void {
    this.byName.delete(name);
    this.flush();
  }

  setPinned(name: string, pinned: boolean): void {
    this.ensure(name).pinned = pinned;
    this.flush();
  }

  setState(name: string, state: SkillUsageState): void {
    this.ensure(name).state = state;
    this.flush();
  }

  get(name: string): SkillUsageRecord | undefined {
    const r = this.byName.get(name);
    return r ? cloneRecord(r) : undefined;
  }

  list(): SkillUsageRecord[] {
    return [...this.byName.values()]
      .map(cloneRecord)
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  private load(): void {
    if (!existsSync(this.path)) return;
    const raw = JSON.parse(readFileSync(this.path, "utf8")) as UsageFile;
    if (raw.schemaVersion !== "skill-usage.v0.1") {
      throw new Error(`Unsupported skill usage file schema: ${this.path}`);
    }
    for (const record of raw.records) {
      this.byName.set(record.name, cloneRecord(record));
    }
  }

  private flush(): void {
    mkdirSync(dirname(this.path), { recursive: true });
    const file: UsageFile = {
      schemaVersion: "skill-usage.v0.1",
      records: this.list(),
    };
    const tmp = `${this.path}.${Date.now()}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(file, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    renameSync(tmp, this.path);
  }

  private ensure(name: string): SkillUsageRecord {
    let r = this.byName.get(name);
    if (!r) {
      r = {
        name,
        useCount: 0,
        patchCount: 0,
        state: "active",
        pinned: false,
        agentCreated: false,
      };
      this.byName.set(name, r);
    }
    return r;
  }
}

function cloneRecord(record: SkillUsageRecord): SkillUsageRecord {
  return {
    ...record,
    metadata: record.metadata ? { ...record.metadata } : undefined,
  };
}
