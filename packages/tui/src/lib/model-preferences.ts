import { mkdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { atomicWriteText } from "@sparkwright/agent-runtime";

const STATE_VERSION = 1;
const MAX_FAVORITES = 250;
const MAX_RECENT = 500;
const MAX_REF_LENGTH = 512;
const MS_PER_DAY = 86_400_000;

export interface RecentModelPreference {
  ref: string;
  lastUsedAt: number;
  useCount: number;
}

export interface ModelPreferencesSnapshot {
  favorites: readonly string[];
  recent: readonly RecentModelPreference[];
}

export const EMPTY_MODEL_PREFERENCES: ModelPreferencesSnapshot = {
  favorites: [],
  recent: [],
};

interface ModelPreferencesState {
  version: typeof STATE_VERSION;
  favorites: string[];
  recent: RecentModelPreference[];
}

export interface ModelPreferences {
  snapshot(): ModelPreferencesSnapshot;
  toggleFavorite(ref: string): Promise<ModelPreferencesSnapshot>;
  recordRecent(ref: string): Promise<ModelPreferencesSnapshot>;
}

export function modelPreferencesPath(
  env: Record<string, string | undefined> = process.env,
): string {
  const base = env.XDG_STATE_HOME?.trim() || join(homedir(), ".local", "state");
  return join(base, "sparkwright", "tui-model-preferences.json");
}

export async function loadModelPreferences(
  env: Record<string, string | undefined> = process.env,
): Promise<ModelPreferences> {
  const path = modelPreferencesPath(env);
  let state = await readState(path);
  let publication = Promise.resolve();
  const snapshot = (): ModelPreferencesSnapshot => ({
    favorites: [...state.favorites],
    recent: state.recent.map((entry) => ({ ...entry })),
  });
  const publish = async (): Promise<ModelPreferencesSnapshot> => {
    const serialized = `${JSON.stringify(state, null, 2)}\n`;
    publication = publication
      .catch(() => undefined)
      .then(async () => {
        await mkdir(dirname(path), { recursive: true });
        await atomicWriteText(path, serialized, { mode: 0o600, durable: true });
      });
    await publication.catch(() => undefined);
    return snapshot();
  };

  return {
    snapshot,
    async toggleFavorite(ref) {
      if (!isModelRef(ref)) return snapshot();
      const favorites = new Set(state.favorites);
      if (favorites.has(ref)) favorites.delete(ref);
      else favorites.add(ref);
      state = {
        ...state,
        favorites: [...favorites].slice(-MAX_FAVORITES),
      };
      return await publish();
    },
    async recordRecent(ref) {
      if (!isModelRef(ref)) return snapshot();
      const previous = state.recent.find((entry) => entry.ref === ref);
      const recent = state.recent.filter((entry) => entry.ref !== ref);
      recent.unshift({
        ref,
        lastUsedAt: Date.now(),
        useCount: Math.min((previous?.useCount ?? 0) + 1, 1_000_000),
      });
      state = { ...state, recent: recent.slice(0, MAX_RECENT) };
      return await publish();
    },
  };
}

export function modelPreferenceScore(
  ref: string,
  preferences: ModelPreferencesSnapshot,
  now = Date.now(),
): number {
  const entry = preferences.recent.find((candidate) => candidate.ref === ref);
  if (!entry) return 0;
  const days = Math.max(0, now - entry.lastUsedAt) / MS_PER_DAY;
  return entry.useCount / (1 + days);
}

export function compareModelPreferences(
  left: string,
  right: string,
  preferences: ModelPreferencesSnapshot,
): number {
  const favorites = new Set(preferences.favorites);
  const favoriteDelta =
    Number(favorites.has(right)) - Number(favorites.has(left));
  if (favoriteDelta !== 0) return favoriteDelta;
  const scoreDelta =
    modelPreferenceScore(right, preferences) -
    modelPreferenceScore(left, preferences);
  return scoreDelta;
}

async function readState(path: string): Promise<ModelPreferencesState> {
  try {
    const parsed = JSON.parse(await readFile(path, "utf8")) as unknown;
    if (!isRecord(parsed) || parsed.version !== STATE_VERSION)
      return emptyState();
    const favorites = Array.isArray(parsed.favorites)
      ? parsed.favorites.filter(isModelRef).slice(0, MAX_FAVORITES)
      : [];
    const recent = Array.isArray(parsed.recent)
      ? parsed.recent
          .filter(isRecentEntry)
          .sort((left, right) => right.lastUsedAt - left.lastUsedAt)
          .slice(0, MAX_RECENT)
      : [];
    return {
      version: STATE_VERSION,
      favorites: [...new Set(favorites)],
      recent: uniqueRecent(recent),
    };
  } catch {
    return emptyState();
  }
}

function emptyState(): ModelPreferencesState {
  return { version: STATE_VERSION, favorites: [], recent: [] };
}

function uniqueRecent(
  entries: RecentModelPreference[],
): RecentModelPreference[] {
  const seen = new Set<string>();
  return entries.filter((entry) => {
    if (seen.has(entry.ref)) return false;
    seen.add(entry.ref);
    return true;
  });
}

function isModelRef(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= MAX_REF_LENGTH &&
    !/\s/.test(value)
  );
}

function isRecentEntry(value: unknown): value is RecentModelPreference {
  if (!isRecord(value) || !isModelRef(value.ref)) return false;
  return (
    typeof value.lastUsedAt === "number" &&
    Number.isFinite(value.lastUsedAt) &&
    value.lastUsedAt >= 0 &&
    typeof value.useCount === "number" &&
    Number.isInteger(value.useCount) &&
    value.useCount > 0
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
