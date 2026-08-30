import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ProjectTrustSnapshot } from "@sparkwright/protocol";
import { ProjectTrustManager } from "../../src/project-trust.js";

/**
 * Existing Host integration fixtures author project capabilities directly.
 * Their trust intent is explicit at the canonical test-runtime boundary so
 * production admission remains fail-closed and trust-specific tests can use
 * the real manager independently.
 */
export class AutoTrustProjectTrustManager extends ProjectTrustManager {
  constructor() {
    super({
      statePath: join(tmpdir(), `sparkwright-auto-trust-${randomUUID()}.json`),
    });
  }

  override async inspect(workspaceRoot: string): Promise<ProjectTrustSnapshot> {
    const snapshot = await super.inspect(workspaceRoot);
    const scopes = snapshot.scopes.map((scope) =>
      scope.status === "untrusted" || scope.status === "changed"
        ? {
            ...scope,
            status: "trusted" as const,
            ...(scope.manifestHash
              ? { trustedManifestHash: scope.manifestHash }
              : {}),
          }
        : scope,
    );
    return {
      ...snapshot,
      status: scopes.some((scope) => scope.status === "invalid")
        ? "invalid"
        : scopes.some((scope) => scope.status === "trusted")
          ? "trusted"
          : "not_required",
      scopes,
    };
  }
}

export function createAutoTrustProjectTrustManager(): ProjectTrustManager {
  return new AutoTrustProjectTrustManager();
}
