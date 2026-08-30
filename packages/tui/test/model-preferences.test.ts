import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  compareModelPreferences,
  loadModelPreferences,
  modelPreferencesPath,
} from "../src/lib/model-preferences.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("model preferences", () => {
  it("persists favorites and bounded recent usage outside project config", async () => {
    const stateHome = await mkdtemp(join(tmpdir(), "sparkwright-model-prefs-"));
    roots.push(stateHome);
    const env = { XDG_STATE_HOME: stateHome };
    const preferences = await loadModelPreferences(env);

    await preferences.toggleFavorite("openai/gpt-favorite");
    await preferences.recordRecent("anthropic/claude-recent");
    await preferences.recordRecent("anthropic/claude-recent");

    const reloaded = await loadModelPreferences(env);
    expect(reloaded.snapshot()).toMatchObject({
      favorites: ["openai/gpt-favorite"],
      recent: [
        expect.objectContaining({
          ref: "anthropic/claude-recent",
          useCount: 2,
        }),
      ],
    });
    expect(modelPreferencesPath(env)).toBe(
      join(stateHome, "sparkwright", "tui-model-preferences.json"),
    );
    expect(await readFile(modelPreferencesPath(env), "utf8")).not.toContain(
      "apiKey",
    );
  });

  it("recovers from malformed state and ranks favorites before recent models", async () => {
    const stateHome = await mkdtemp(join(tmpdir(), "sparkwright-model-prefs-"));
    roots.push(stateHome);
    const env = { XDG_STATE_HOME: stateHome };
    const path = modelPreferencesPath(env);
    await mkdir(join(stateHome, "sparkwright"), { recursive: true });
    await writeFile(path, "not-json", "utf8");
    const preferences = await loadModelPreferences(env);
    expect(preferences.snapshot()).toEqual({ favorites: [], recent: [] });

    const snapshot = {
      favorites: ["openai/favorite"],
      recent: [{ ref: "openai/recent", lastUsedAt: Date.now(), useCount: 20 }],
    };
    expect(
      ["openai/recent", "openai/favorite"].sort((left, right) =>
        compareModelPreferences(left, right, snapshot),
      ),
    ).toEqual(["openai/favorite", "openai/recent"]);
  });
});
