import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

interface DeliveryAttempt {
  status: "delivered" | "failed";
  attemptedAt: number;
  error?: string;
}

interface StoreData {
  processedMessages: Record<string, number>;
  deliveryAttempts: Record<string, DeliveryAttempt[]>;
}

/** Gateway-owned transport dedupe and delivery-attempt facts only. */
export class GatewayStore {
  private data: StoreData = {
    processedMessages: {},
    deliveryAttempts: {},
  };
  private loaded = false;

  constructor(private readonly path: string) {}

  async load(): Promise<void> {
    if (this.loaded) return;
    try {
      const raw = await readFile(this.path, "utf8");
      const parsed = JSON.parse(raw) as Partial<StoreData>;
      this.data = {
        processedMessages: parsed.processedMessages ?? {},
        deliveryAttempts: parsed.deliveryAttempts ?? {},
      };
    } catch {
      // Missing or corrupt transport state does not prevent daemon startup.
    }
    this.loaded = true;
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
    trimOldest(this.data.processedMessages, 2_000);
    await this.save();
  }

  async recordDeliveryAttempt(
    deliveryKey: string,
    status: DeliveryAttempt["status"],
    error?: string,
  ): Promise<void> {
    await this.load();
    const attempts = this.data.deliveryAttempts[deliveryKey] ?? [];
    attempts.push({
      status,
      attemptedAt: Date.now(),
      ...(error ? { error } : {}),
    });
    this.data.deliveryAttempts[deliveryKey] = attempts.slice(-10);
    const latest = Object.fromEntries(
      Object.entries(this.data.deliveryAttempts).map(([key, values]) => [
        key,
        values.at(-1)?.attemptedAt ?? 0,
      ]),
    );
    const removed = trimOldest(latest, 2_000);
    for (const key of removed) delete this.data.deliveryAttempts[key];
    await this.save();
  }

  async deliveryAttempts(deliveryKey: string): Promise<DeliveryAttempt[]> {
    await this.load();
    return [...(this.data.deliveryAttempts[deliveryKey] ?? [])];
  }

  private async save(): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true });
    const tmp = `${this.path}.${process.pid}.tmp`;
    await writeFile(tmp, JSON.stringify(this.data, null, 2), "utf8");
    await rename(tmp, this.path);
  }
}

function trimOldest(entries: Record<string, number>, limit: number): string[] {
  const values = Object.entries(entries);
  if (values.length <= limit) return [];
  const removed = values
    .sort((left, right) => left[1] - right[1])
    .slice(0, values.length - limit)
    .map(([key]) => key);
  for (const key of removed) delete entries[key];
  return removed;
}
