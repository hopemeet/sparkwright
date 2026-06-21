# Design: Trace Diagnostics Refactor (conservative module split)

> Rev 0 planning note. This is a design target, not the active routing map.
> Active trace contracts still live in
> [../maps/trace/raw-trace.md](../maps/trace/raw-trace.md),
> [../maps/trace/summary-timeline-verify.md](../maps/trace/summary-timeline-verify.md),
> [../maps/session/session-store.md](../maps/session/session-store.md),
> `packages/core/src/trace.ts`, and `docs/reference/RUN_EVENTS.md`.

## 1. Background

`packages/core/src/trace.ts` has grown into a mixed trace infrastructure file.
It currently contains both:

- raw trace storage and replay machinery (`FileRunStore`, session trace layout,
  checkpoint reconstruction, transcript prompt restore, trace filtering and
  redaction);
- derived diagnostics (`summary`, `timeline`, `report`, and `verify`);
- session consistency / repair helpers that read session-store shaped files but
  reuse diagnostics such as `summarizeTraceJsonl`.

The raw trace is intentionally a durable append-only evidence log, and it is
coupled to more than human review:

- CLI commands: `trace summary|events|timeline|report|verify`;
- host/session APIs such as `session.inspect`;
- TUI session diagnostics and exports;
- replay/resume fallback;
- tests, scripts, and future user automation around trace JSON/text output.

Therefore this refactor must not start by changing the event envelope, event
names, payload shapes, CLI output, or public exports. The first step should
reduce file-level cognitive load while preserving behavior byte-for-byte where
possible.

## 2. Goals

- Split the largest trace implementation file along low-risk module boundaries.
- Keep `trace.ts` as the stable import facade during the first phase.
- Preserve all public `@sparkwright/core` export names and CLI output shapes.
- Make later changes safer: a future facts layer, analyzer split, or
  compaction-specific trace view should happen behind clearer module seams.
- Keep rollback cheap: if the move is wrong, revert the module split without
  also unwinding semantic changes.

## 3. Non-Goals

This design explicitly does **not** propose these in phase 1:

- changing `SparkwrightEvent` or the JSONL envelope;
- renaming event types or changing persisted payload contracts;
- changing `trace summary|timeline|report|verify` JSON or text output;
- changing `packages/core/src/index.ts` or `packages/core/src/internal.ts`
  to import from new module paths;
- moving `validateSessionTraceConsistency()` or
  `repairSessionTraceConsistency()` out of `trace.ts`;
- introducing a general `TraceFacts` model;
- generalizing `SessionTraceFacts` from `session-compaction.ts`;
- splitting report findings into analyzer plugins;
- adding `session.compact.*`, `session.summarizer.*`, or
  `session.oracle.*` event families.

Those may be good follow-up changes, but they are semantic or architectural
decisions. Phase 1 is only a physical module-boundary cleanup.

## 4. Current Source Facts

Verified by reading current source during this design pass:

- `packages/core/src/trace.ts` is about 4.5k lines and contains both trace
  diagnostics and storage/replay helpers.
- `packages/core/src/index.ts` and `packages/core/src/internal.ts` are the real
  package-facing surfaces. They use **named** re-exports from `./trace.js`, not
  `export *`.
- Repository deep imports from `./trace.js` are effectively confined to core's
  own `index.ts` and `internal.ts`; this makes a `trace.ts` facade a practical
  rollback boundary.
- `buildTraceReport()` is a broad diagnostics function with many independent
  finding blocks over raw events and summary evidence.
- `validateSessionTraceConsistency()` depends on both session-store shaped files
  and diagnostic helpers such as `summarizeTraceJsonl`; it is a seam, not a
  clean member of either storage or diagnostics.
- `parseTraceJsonl` / event loading helpers are shared by verification and
  session consistency. Moving them carelessly would turn a pure move into an
  unintended dependency redesign.
- Runtime context compaction events already exist as
  `context.compaction_requested`, `context.compaction.started`,
  `context.compaction.completed`, and `context.compaction.failed`.
- `SessionTraceFacts` already exists in `session-compaction.ts`, but it is a
  compaction-oracle signal shape (`approvals`, `workspaceWrites`, `subagents`),
  not a general trace facts layer.

## 5. Phase 1: Conservative Module Split

Phase 1 creates two clean endpoint modules, one shared leaf module, and leaves
the session consistency seam in `trace.ts`.

### 5.1 New `trace-diagnostics.ts`

Move pure diagnostic types/functions and their parse/load helpers here:

- `TraceSummary`;
- `TraceReport*`;
- `TraceTimeline*`;
- `TraceVerification*`;
- `loadTraceEventsFile()`;
- `loadTraceEventsJsonl()`;
- `summarizeTraceFile()`;
- `summarizeTraceJsonl()`;
- `buildTraceTimelineFile()`;
- `buildTraceTimelineJsonl()`;
- `buildTraceTimeline()`;
- `buildTraceReportFile()`;
- `buildTraceReportJsonl()`;
- `buildTraceReport()`;
- `verifyTraceFile()`;
- `verifyTraceJsonl()`;
- `parseTraceJsonl` or equivalent JSONL parsing helpers, exported only if
  facade-held consistency code needs to import them;
- pure helper functions that are only used by those diagnostics.

These functions may read a trace file path at the file-entry wrapper level, but
they must not depend on `FileRunStore`, checkpoint reconstruction, or session
repair internals.

`parseTraceJsonl` follows diagnostics in phase 1. Verification and event
loading already depend on it, and `validateSessionTraceConsistency()` can import
downward from diagnostics while it remains in the facade. Do not leave a helper
in `trace.ts` if a moved module needs it; that would force
`trace-diagnostics.ts -> trace.ts` and create a facade cycle.

### 5.2 New `trace-codec.ts` Shared Leaf

Create a small dependency-leaf module for JSONL codec, redaction, and trace
filtering primitives used by both diagnostics and storage:

- `TraceLevel`;
- `TraceRedactor`;
- `TraceRedactionOptions`;
- `serializeEventJsonl()`;
- `createTraceRedactor()`;
- `isVerboseStreamEvent()`;
- `filterTraceEvent()`;
- codec/filter/redaction helper functions used exclusively by those exports.

This module may import event types and other true leaves, but it must not import
`trace.ts`, `trace-diagnostics.ts`, or `trace-store.ts`. If these primitives
eventually belong closer to the event envelope, moving them into `events.ts` or
a sibling event codec module is also acceptable. They must not be treated as
store-private, because diagnostics currently needs `serializeEventJsonl()` when
building report evidence from in-memory events.

### 5.3 New `trace-store.ts`

Move storage/replay helpers here:

- `MemoryTrace`;
- `FileRunStore`;
- `FileRunStoreOptions`;
- `SessionFileRunStoreFactoryOptions`;
- `createSessionFileRunStoreFactory()`;
- `loadCheckpointFromRunDir()`;
- `LoadCheckpointFromRunDirOptions`;
- `restoreTranscriptPrompts()`;
- `bindStorageDegradationEvents()`;
- storage-only helper functions used exclusively by those exports.

`trace-store.ts` may import codec/filter/redaction primitives from
`trace-codec.ts`. It must not import `trace-diagnostics.ts` during phase 1.
Session consistency is intentionally left in `trace.ts` so the storage endpoint
does not need a diagnostics dependency.

### 5.4 Keep `trace.ts` as a Named Facade

`trace.ts` remains the import target used by `index.ts` and `internal.ts`.
Facade exports should be **named**, not `export *`, so missed exports and name
collisions fail at compile time.

Example shape:

```ts
export {
  summarizeTraceFile,
  summarizeTraceJsonl,
  loadTraceEventsFile,
  loadTraceEventsJsonl,
  buildTraceTimeline,
  buildTraceTimelineFile,
  buildTraceTimelineJsonl,
  buildTraceReport,
  buildTraceReportFile,
  buildTraceReportJsonl,
  verifyTraceFile,
  verifyTraceJsonl,
} from "./trace-diagnostics.js";

export type {
  TraceSummary,
  TraceTimeline,
  TraceTimelinePhase,
  TraceReport,
  TraceReportFinding,
  TraceVerificationReport,
} from "./trace-diagnostics.js";

export {
  serializeEventJsonl,
  createTraceRedactor,
  isVerboseStreamEvent,
  filterTraceEvent,
} from "./trace-codec.js";

export type {
  TraceLevel,
  TraceRedactor,
  TraceRedactionOptions,
} from "./trace-codec.js";

export {
  FileRunStore,
  MemoryTrace,
  createSessionFileRunStoreFactory,
  loadCheckpointFromRunDir,
  restoreTranscriptPrompts,
  bindStorageDegradationEvents,
} from "./trace-store.js";
```

`index.ts` / `internal.ts` should remain pointed at `./trace.js` during phase 1.
Their named re-exports become the compiler-backed guard that the facade still
provides the same symbols.

Dependency rule: moved modules must never import the facade (`./trace.js`).
Shared helpers must move downward into the owning endpoint or a leaf such as
`trace-codec.ts`; the facade may import downward, but the reverse direction is
forbidden. This is what keeps the patch a mechanical split instead of an
implicit dependency redesign.

### 5.5 Leave Consistency / Repair in `trace.ts`

Do not move these in phase 1:

- `SessionTraceConsistencyFinding`;
- `SessionTraceConsistencyReport`;
- `ValidateSessionTraceConsistencyOptions`;
- `SessionTraceRepairAction`;
- `SessionTraceRepairReport`;
- `RepairSessionTraceConsistencyOptions`;
- `validateSessionTraceConsistency()`;
- `repairSessionTraceConsistency()`.

They sit between storage-shaped session files and diagnostic summaries. Moving
them immediately would force either:

- `trace-store -> trace-diagnostics` imports;
- a third internal module;
- or premature extraction of shared trace-loading helpers.

All three would turn "move code" into "redesign dependencies". Keep this seam in
the facade until phase 1 proves stable. While it remains there, it should import
diagnostic helpers such as `summarizeTraceJsonl` and `parseTraceJsonl` downward
from `trace-diagnostics.ts`, never the other way around.

## 6. Verification Plan

Before the split, establish fixtures or snapshots for representative traces.
After the split, assert behavior is unchanged.

Required checks:

- `npm run build`
- `npm --workspace @sparkwright/streaming-runtime run build`
- `npm --workspace @sparkwright/core test -- test/trace.test.ts`
- `npm --workspace @sparkwright/cli test -- test/cli.test.ts`
- `sparkwright trace summary <fixture> --format json`
- `sparkwright trace timeline <fixture> --format json`
- `sparkwright trace report <fixture> --format json`
- `sparkwright trace verify <fixture> --format json`
- text-output snapshots for at least `summary`, `timeline`, `report`, and
  `verify`;
- a TypeScript compile check that the named exports in
  `packages/core/src/index.ts` and `packages/core/src/internal.ts` still resolve.

The core build is not a substitute for output snapshots. The build catches
missing symbols; snapshots catch accidental formatting, ordering, and JSON shape
changes.

## 7. Follow-Up Decisions

Only after phase 1 lands cleanly:

1. Decide whether session consistency / repair deserves
   `trace-session-consistency.ts` or should stay with storage.
2. Decide whether a general `TraceFacts` layer is needed. If yes, define its
   ownership and keep it distinct from `SessionTraceFacts` unless their
   semantics truly match.
3. Split `buildTraceReport()` findings into analyzer functions only after the
   facts boundary is known.
4. Consider narrow session compaction events if existing paths cannot answer
   specific review questions. A useful litmus: if "why was this LLM session
   summary rejected by the oracle?" can only be answered by manually opening
   `compact.json`, then a minimal `session.oracle.rejected` event may be
   justified.
5. Consider domain-specific human views such as `trace compaction-report` only
   after the required facts are present in trace or a documented artifact path.

## 8. Risks

- **Silent output drift.** Moving code can reorder object keys, findings, or
  text sections. Snapshot before moving.
- **Facade drift.** `export *` can hide accidental overlap. Use named
  re-exports.
- **Facade cycles.** If a moved module imports `./trace.js`, the facade has
  become part of the implementation graph. Push shared helpers down into
  diagnostics, storage, or `trace-codec.ts` instead.
- **Hidden dependency redesign.** Moving consistency / repair too early can
  create new module dependencies under the guise of cleanup.
- **Parallel facts models.** Generalizing `SessionTraceFacts` without a clear
  owner can create competing definitions of trace truth.
- **Event bloat.** Adding session/oracle events before proving an evidence gap
  can make traces noisier without improving review.

## 9. Recommended First Patch

The first implementation patch should be intentionally boring:

1. add `trace-codec.ts` for shared codec/filter/redaction primitives;
2. add `trace-diagnostics.ts`;
3. add `trace-store.ts`;
4. move clean endpoint exports and their private helpers;
5. keep `trace.ts` as a named facade plus consistency / repair;
6. do not touch `index.ts`, `internal.ts`, protocol docs, event docs, or CLI
   formatting code except if imports must be mechanically adjusted;
7. run the verification plan.

If the patch changes any trace output, event schema, public export name, or
session consistency behavior, it is no longer phase 1. If any moved module
imports `./trace.js`, it is also no longer phase 1.
