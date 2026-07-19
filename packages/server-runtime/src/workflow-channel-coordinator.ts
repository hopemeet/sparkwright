import type {
  AnyActorNotification,
  FileWorkflowChannelStore,
  FileWorkflowNotificationOutbox,
  WorkflowChannelBinding,
  WorkflowRunId,
} from "@sparkwright/agent-runtime";

export interface WorkflowChannelDeliveryAdapter {
  deliver(input: {
    binding: WorkflowChannelBinding;
    notification: AnyActorNotification;
    deliveryKey: string;
  }): Promise<{ transportMessageId?: string }>;
}

export interface WorkflowChannelDeliveryReport {
  notifications: number;
  attempted: string[];
  delivered: string[];
  failed: Array<{ deliveryKey: string; message: string }>;
  skipped: string[];
}

export class WorkflowChannelCoordinator {
  constructor(
    private readonly options: {
      outbox: FileWorkflowNotificationOutbox;
      channels: FileWorkflowChannelStore;
      adapter: WorkflowChannelDeliveryAdapter;
      now?: () => Date;
    },
  ) {}

  async runOnce(): Promise<WorkflowChannelDeliveryReport> {
    const report: WorkflowChannelDeliveryReport = {
      notifications: 0,
      attempted: [],
      delivered: [],
      failed: [],
      skipped: [],
    };
    const notifications = await this.options.outbox.peek(
      (notification) => notification.source.kind === "workflow",
    );
    report.notifications = notifications.length;
    for (const notification of notifications) {
      if (notification.source.kind !== "workflow") continue;
      const workflowRunId = notification.source.id as WorkflowRunId;
      const snapshot = this.options.channels.snapshot(workflowRunId);
      const revoked = new Set(
        snapshot.revocations.map((entry) => entry.bindingId),
      );
      for (const binding of snapshot.bindings) {
        const deliveryKey = `${binding.bindingId}:${notification.id}`;
        if (
          this.options.channels.hasTerminalDelivery(
            workflowRunId,
            binding.bindingId,
            notification.id,
          )
        ) {
          report.skipped.push(deliveryKey);
          continue;
        }
        const at = this.options.now?.() ?? new Date();
        if (revoked.has(binding.bindingId)) {
          await this.options.channels.recordDelivery({
            schemaVersion: "sparkwright-workflow-channel-delivery.v1",
            bindingId: binding.bindingId,
            workflowRunId,
            notificationId: notification.id,
            deliveryKey,
            status: "revoked",
            attemptedAt: at.toISOString(),
          });
          report.skipped.push(deliveryKey);
          continue;
        }
        if (Date.parse(binding.expiresAt) <= at.getTime()) {
          await this.options.channels.recordDelivery({
            schemaVersion: "sparkwright-workflow-channel-delivery.v1",
            bindingId: binding.bindingId,
            workflowRunId,
            notificationId: notification.id,
            deliveryKey,
            status: "expired",
            attemptedAt: at.toISOString(),
          });
          report.skipped.push(deliveryKey);
          continue;
        }
        report.attempted.push(deliveryKey);
        try {
          const result = await this.options.adapter.deliver({
            binding,
            notification,
            deliveryKey,
          });
          await this.options.channels.recordDelivery({
            schemaVersion: "sparkwright-workflow-channel-delivery.v1",
            bindingId: binding.bindingId,
            workflowRunId,
            notificationId: notification.id,
            deliveryKey,
            status: "delivered",
            attemptedAt: at.toISOString(),
            ...(result.transportMessageId
              ? { transportMessageId: result.transportMessageId }
              : {}),
          });
          report.delivered.push(deliveryKey);
        } catch (cause) {
          const message =
            cause instanceof Error ? cause.message : String(cause);
          await this.options.channels.recordDelivery({
            schemaVersion: "sparkwright-workflow-channel-delivery.v1",
            bindingId: binding.bindingId,
            workflowRunId,
            notificationId: notification.id,
            deliveryKey,
            status: "failed",
            attemptedAt: at.toISOString(),
            error: message,
          });
          report.failed.push({ deliveryKey, message });
        }
      }
    }
    return report;
  }
}
