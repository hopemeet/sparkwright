import type { CronJob, Schedule } from "./model.js";

export const ONESHOT_GRACE_SECONDS = 120;
export const MIN_RECURRING_GRACE_SECONDS = 120;
export const MAX_RECURRING_GRACE_SECONDS = 7200;

export interface ParsedSchedule {
  schedule: Schedule;
  display: string;
}

export function parseSchedule(input: string, now = new Date()): ParsedSchedule {
  const text = input.trim();
  if (!text) throw new Error("schedule must not be empty");

  const every =
    /^every\s+(\d+)\s*(m|min|mins|minute|minutes|h|hour|hours|d|day|days)$/i.exec(
      text,
    );
  if (every) {
    const minutes = durationToMinutes(Number(every[1]), every[2]!);
    return {
      schedule: { kind: "interval", minutes },
      display: `every ${formatMinutes(minutes)}`,
    };
  }

  if (looksLikeCron(text)) {
    parseCronExpression(text);
    return { schedule: { kind: "cron", expr: text }, display: text };
  }

  const date = parseIsoLikeDate(text);
  if (date) {
    return {
      schedule: { kind: "once", runAt: date.toISOString() },
      display: date.toISOString(),
    };
  }

  const delay =
    /^(?:in\s+)?(\d+)\s*(m|min|mins|minute|minutes|h|hour|hours|d|day|days)$/i.exec(
      text,
    );
  if (delay) {
    const minutes = durationToMinutes(Number(delay[1]), delay[2]!);
    const runAt = new Date(now.getTime() + minutes * 60_000);
    return {
      schedule: { kind: "once", runAt: runAt.toISOString() },
      display: `in ${formatMinutes(minutes)}`,
    };
  }

  throw new Error(
    "schedule must be a delay (30m), interval (every 2h), cron expression, or ISO timestamp",
  );
}

export function computeNextRun(
  schedule: Schedule,
  from = new Date(),
): string | null {
  if (schedule.kind === "once") return schedule.runAt;
  if (schedule.kind === "interval") {
    return new Date(from.getTime() + schedule.minutes * 60_000).toISOString();
  }
  return nextCronDate(schedule.expr, from).toISOString();
}

export function computeGraceSeconds(schedule: Schedule): number {
  if (schedule.kind === "once") return ONESHOT_GRACE_SECONDS;
  const seconds =
    schedule.kind === "interval"
      ? schedule.minutes * 30
      : estimateCronPeriodSeconds(schedule.expr) / 2;
  return clamp(
    Math.floor(seconds),
    MIN_RECURRING_GRACE_SECONDS,
    MAX_RECURRING_GRACE_SECONDS,
  );
}

export function jobIsDue(job: CronJob, now = new Date()): boolean {
  if (!job.enabled || job.state === "paused" || job.state === "completed") {
    return false;
  }
  if (!job.nextRunAt) return false;
  const next = new Date(job.nextRunAt);
  if (Number.isNaN(next.getTime())) return false;
  if (next.getTime() > now.getTime()) return false;
  const lateBySeconds = (now.getTime() - next.getTime()) / 1000;
  return lateBySeconds <= computeGraceSeconds(job.schedule);
}

export function shouldFastForward(job: CronJob, now = new Date()): boolean {
  if (!job.enabled || job.state === "paused" || job.schedule.kind === "once") {
    return false;
  }
  if (!job.nextRunAt) return false;
  const next = new Date(job.nextRunAt);
  if (Number.isNaN(next.getTime()) || next.getTime() > now.getTime()) {
    return false;
  }
  const lateBySeconds = (now.getTime() - next.getTime()) / 1000;
  return lateBySeconds > computeGraceSeconds(job.schedule);
}

function durationToMinutes(value: number, unit: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error("duration must be a positive integer");
  }
  const normalized = unit.toLowerCase();
  if (normalized.startsWith("m")) return value;
  if (normalized.startsWith("h")) return value * 60;
  return value * 24 * 60;
}

function formatMinutes(minutes: number): string {
  if (minutes % 1440 === 0) return `${minutes / 1440}d`;
  if (minutes % 60 === 0) return `${minutes / 60}h`;
  return `${minutes}m`;
}

function parseIsoLikeDate(text: string): Date | null {
  if (!/^\d{4}-\d{2}-\d{2}/.test(text)) return null;
  const date = new Date(text);
  if (Number.isNaN(date.getTime())) {
    throw new Error(`invalid timestamp: ${text}`);
  }
  return date;
}

function looksLikeCron(text: string): boolean {
  const parts = text.split(/\s+/);
  return parts.length === 5 && parts.every((p) => /^[\d*,/-]+$/.test(p));
}

interface CronSpec {
  minute: Set<number>;
  hour: Set<number>;
  dom: Set<number>;
  month: Set<number>;
  dow: Set<number>;
}

function parseCronExpression(expr: string): CronSpec {
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) throw new Error("cron expression must have 5 fields");
  return {
    minute: parseCronField(parts[0]!, 0, 59),
    hour: parseCronField(parts[1]!, 0, 23),
    dom: parseCronField(parts[2]!, 1, 31),
    month: parseCronField(parts[3]!, 1, 12),
    dow: normalizeDow(parseCronField(parts[4]!, 0, 7)),
  };
}

function parseCronField(field: string, min: number, max: number): Set<number> {
  const values = new Set<number>();
  for (const part of field.split(",")) {
    const [rangePart, stepPart] = part.split("/");
    const step = stepPart === undefined ? 1 : Number(stepPart);
    if (!Number.isSafeInteger(step) || step <= 0) {
      throw new Error(`invalid cron step: ${part}`);
    }
    let start: number;
    let end: number;
    if (rangePart === "*") {
      start = min;
      end = max;
    } else if (rangePart?.includes("-")) {
      const [left, right] = rangePart.split("-");
      start = Number(left);
      end = Number(right);
    } else {
      start = Number(rangePart);
      end = start;
    }
    if (
      !Number.isSafeInteger(start) ||
      !Number.isSafeInteger(end) ||
      start < min ||
      end > max ||
      start > end
    ) {
      throw new Error(`invalid cron field: ${field}`);
    }
    for (let value = start; value <= end; value += step) values.add(value);
  }
  if (values.size === 0) throw new Error(`invalid cron field: ${field}`);
  return values;
}

function normalizeDow(input: Set<number>): Set<number> {
  const values = new Set<number>();
  for (const value of input) values.add(value === 7 ? 0 : value);
  return values;
}

function nextCronDate(expr: string, from: Date): Date {
  const spec = parseCronExpression(expr);
  const candidate = new Date(from.getTime() + 60_000);
  candidate.setUTCSeconds(0, 0);
  const deadline = from.getTime() + 5 * 366 * 24 * 60 * 60_000;
  while (candidate.getTime() <= deadline) {
    if (matchesCron(spec, candidate)) return candidate;
    candidate.setUTCMinutes(candidate.getUTCMinutes() + 1);
  }
  throw new Error(`could not compute next run for cron expression: ${expr}`);
}

function matchesCron(spec: CronSpec, date: Date): boolean {
  return (
    spec.minute.has(date.getUTCMinutes()) &&
    spec.hour.has(date.getUTCHours()) &&
    spec.dom.has(date.getUTCDate()) &&
    spec.month.has(date.getUTCMonth() + 1) &&
    spec.dow.has(date.getUTCDay())
  );
}

function estimateCronPeriodSeconds(expr: string): number {
  const first = nextCronDate(expr, new Date("2026-01-01T00:00:00.000Z"));
  const second = nextCronDate(expr, first);
  return Math.max(60, (second.getTime() - first.getTime()) / 1000);
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}
