/**
 * Session list types. The actual enumeration now happens in the host (via
 * the protocol's session.list request); this file only exports the shape
 * the TUI's session dialog renders.
 */

export interface SessionSummary {
  id: string;
  mtimeMs: number;
  preview: string;
}

export interface SessionDiagnostics {
  sessionId: string;
  summary: {
    eventCount?: number;
    runIds?: string[];
    agentIds?: string[];
    errorCount?: number;
    artifactCount?: number;
    usage?: { totalTokens?: number };
  };
  consistency: {
    ok?: boolean;
    findings?: Array<{
      severity?: string;
      code?: string;
      message?: string;
    }>;
  };
  timeline: {
    durationMs?: number;
    phases?: Array<{
      category?: string;
      label?: string;
      status?: string;
      durationMs?: number;
      startSequence?: number;
      endSequence?: number;
    }>;
  };
}
