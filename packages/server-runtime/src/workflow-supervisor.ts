import type {
  FileWorkflowStore,
  WorkflowLeaseBoundWriter,
  WorkflowRunRecord,
  WorkflowWorkerHandle,
} from "@sparkwright/agent-runtime";

export interface WorkflowSupervisorWorkerAdapter {
  runClaimed(input: {
    record: WorkflowRunRecord;
    writer: WorkflowLeaseBoundWriter;
    signal: AbortSignal;
  }): Promise<"waiting" | "terminal" | "interrupted">;
}

export interface WorkflowSupervisorRunReport {
  scanned: number;
  claimed: string[];
  busy: string[];
  skipped: string[];
  failed: Array<{ workflowRunId: string; message: string }>;
}

export class WorkflowSupervisor {
  private readonly active = new Map<string, AbortController>();
  private accepting = true;

  constructor(
    private readonly options: {
      store: FileWorkflowStore;
      worker: WorkflowWorkerHandle;
      adapter: WorkflowSupervisorWorkerAdapter;
      leaseTtlMs?: number;
      maxClaims?: number;
      includeWaiting?: (record: WorkflowRunRecord) => boolean;
      now?: () => Date;
      leaseNow?: () => Date;
    },
  ) {}

  async runOnce(): Promise<WorkflowSupervisorRunReport> {
    const report: WorkflowSupervisorRunReport = {
      scanned: 0,
      claimed: [],
      busy: [],
      skipped: [],
      failed: [],
    };
    const worker = this.options.worker.record();
    if (
      !this.accepting ||
      worker.state !== "active" ||
      Date.parse(worker.expiresAt) <=
        (this.options.now?.() ?? new Date()).getTime()
    )
      return report;
    const candidates = this.options.store
      .list()
      .records.filter(
        (record) =>
          record.status !== "completed" &&
          record.status !== "failed" &&
          record.status !== "cancelled",
      )
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    report.scanned = candidates.length;
    const limit = this.options.maxClaims ?? 1;
    for (const record of candidates) {
      if (report.claimed.length >= limit || !this.accepting) break;
      if (
        this.active.has(record.id) ||
        (record.status === "waiting" && !this.options.includeWaiting?.(record))
      ) {
        report.skipped.push(record.id);
        continue;
      }
      const writer = await this.options.store.acquireWriter(record.id, {
        owner: `worker:${worker.workerId}:${worker.instanceId}`,
        ttlMs: this.options.leaseTtlMs,
        now: this.options.leaseNow,
      });
      if (!writer) {
        report.busy.push(record.id);
        continue;
      }
      const controller = new AbortController();
      this.active.set(record.id, controller);
      report.claimed.push(record.id);
      try {
        const fresh = await writer.readFresh();
        if (!fresh) throw new Error("claimed workflow record disappeared");
        await this.options.adapter.runClaimed({
          record: fresh,
          writer,
          signal: controller.signal,
        });
      } catch (cause) {
        report.failed.push({
          workflowRunId: record.id,
          message: cause instanceof Error ? cause.message : String(cause),
        });
      } finally {
        this.active.delete(record.id);
        await writer.release();
      }
    }
    return report;
  }

  async heartbeat(ttlMs?: number): Promise<boolean> {
    return this.options.worker.heartbeat(ttlMs);
  }

  async drain(input: { abort?: boolean } = {}): Promise<{
    drained: boolean;
    remainingWorkflowRunIds: string[];
  }> {
    this.accepting = false;
    await this.options.worker.drain();
    if (input.abort) {
      for (const controller of this.active.values()) controller.abort();
    }
    const remainingWorkflowRunIds = [...this.active.keys()];
    return {
      drained: remainingWorkflowRunIds.length === 0,
      remainingWorkflowRunIds,
    };
  }

  async stop(): Promise<void> {
    this.accepting = false;
    for (const controller of this.active.values()) controller.abort();
    await this.options.worker.stop();
  }

  activeWorkflowRunIds(): string[] {
    return [...this.active.keys()];
  }
}
