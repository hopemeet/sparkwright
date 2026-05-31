import { describe, expect, it } from "vitest";
import {
  ConcurrencyCoordinator,
  globsOverlap,
} from "../src/concurrency/index.js";

describe("globsOverlap", () => {
  it("treats identical globs as overlapping", () => {
    expect(globsOverlap("src/auth/**", "src/auth/**")).toBe(true);
    expect(globsOverlap("a/b.ts", "a/b.ts")).toBe(true);
  });

  it("detects parent / child overlap", () => {
    expect(globsOverlap("src/auth/**", "src/auth/foo.ts")).toBe(true);
    expect(globsOverlap("src/**", "src/auth/foo.ts")).toBe(true);
  });

  it("rejects disjoint literal paths", () => {
    expect(globsOverlap("src/auth/foo.ts", "src/billing/bar.ts")).toBe(false);
    expect(globsOverlap("src/auth/**", "src/billing/**")).toBe(false);
  });

  it("handles ** at the root", () => {
    expect(globsOverlap("**/*.test.ts", "src/auth/foo.test.ts")).toBe(true);
    expect(globsOverlap("**/*.test.ts", "src/auth/foo.ts")).toBe(false);
  });

  it("handles same-segment wildcards", () => {
    expect(globsOverlap("src/*.ts", "src/foo.ts")).toBe(true);
    expect(globsOverlap("src/*.ts", "src/foo.md")).toBe(false);
  });

  it("anchors by literal prefix when both have wildcards", () => {
    // 'foo*' and 'bar*' cannot share a witness string.
    expect(globsOverlap("src/foo*.ts", "src/bar*.ts")).toBe(false);
    // 'foo*' and '*bar' could both match 'foobar'.
    expect(globsOverlap("src/foo*", "src/*bar")).toBe(true);
  });

  it("anchors by literal suffix when both have wildcards", () => {
    expect(globsOverlap("src/*.ts", "src/*.md")).toBe(false);
    expect(globsOverlap("src/*.test.ts", "src/*.ts")).toBe(true);
  });

  it("collapses ./ and repeated slashes", () => {
    expect(globsOverlap("./src/auth/**", "src//auth/foo.ts")).toBe(true);
  });

  it("treats ** as zero-or-more whole segments", () => {
    expect(globsOverlap("src/**/foo.ts", "src/foo.ts")).toBe(true);
    expect(globsOverlap("src/**/foo.ts", "src/a/b/foo.ts")).toBe(true);
    expect(globsOverlap("src/**/foo.ts", "src/foo.md")).toBe(false);
  });
});

describe("ConcurrencyCoordinator", () => {
  it("grants non-overlapping claims", () => {
    const coord = new ConcurrencyCoordinator();
    expect(coord.acquire("t1", ["src/auth/**"]).status).toBe("granted");
    expect(coord.acquire("t2", ["src/billing/**"]).status).toBe("granted");
    expect(coord.size()).toBe(2);
  });

  it("rejects overlapping claims with conflictsWith", () => {
    const coord = new ConcurrencyCoordinator();
    coord.acquire("t1", ["src/auth/**"]);
    const r = coord.acquire("t2", ["src/auth/foo.ts"]);
    expect(r.status).toBe("conflict");
    if (r.status === "conflict") {
      expect(r.conflictsWith).toEqual(["t1"]);
      expect(r.reason).toContain("t1");
    }
  });

  it("treats empty writes as workspace-wide exclusive", () => {
    const coord = new ConcurrencyCoordinator();
    expect(coord.acquire("wide", []).status).toBe("granted");
    expect(coord.acquire("narrow", ["src/foo.ts"]).status).toBe("conflict");
  });

  it("allows reuse of a claim id after release", () => {
    const coord = new ConcurrencyCoordinator();
    coord.acquire("t1", ["src/auth/**"]);
    coord.release("t1");
    expect(coord.acquire("t1", ["src/auth/**"]).status).toBe("granted");
  });

  it("treats duplicate live claim ids as a programmer error", () => {
    const coord = new ConcurrencyCoordinator();
    coord.acquire("t1", ["src/auth/**"]);
    expect(() => coord.acquire("t1", ["src/auth/**"])).toThrow(
      /claim id already in use/,
    );
  });

  it("release is idempotent for unknown ids", () => {
    const coord = new ConcurrencyCoordinator();
    expect(() => coord.release("never-existed")).not.toThrow();
  });

  it("inFlight returns a snapshot with timestamps", () => {
    const coord = new ConcurrencyCoordinator();
    coord.acquire("t1", ["src/a/**"]);
    coord.acquire("t2", ["src/b/**"]);
    const snap = coord.inFlight();
    expect(snap.map((c) => c.claimId).sort()).toEqual(["t1", "t2"]);
    for (const claim of snap) {
      expect(typeof claim.acquiredAt).toBe("string");
      expect(claim.writes.length).toBeGreaterThan(0);
    }
  });

  it("reports all conflicting in-flight claims, not just one", () => {
    const coord = new ConcurrencyCoordinator();
    coord.acquire("t1", ["src/auth/**"]);
    coord.acquire("t2", ["src/auth/foo.ts"]); // would conflict with t1; doesn't because t1 already holds it
    // Re-prepare: independent grants then a third overlapping claim.
    const coord2 = new ConcurrencyCoordinator();
    coord2.acquire("a", ["src/auth/**"]);
    coord2.acquire("b", ["src/billing/**"]);
    const r = coord2.acquire("c", ["src/**"]);
    expect(r.status).toBe("conflict");
    if (r.status === "conflict") {
      expect(r.conflictsWith.sort()).toEqual(["a", "b"]);
    }
  });
});
