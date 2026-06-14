import React from "react";
import type { CapabilitySnapshot } from "@sparkwright/protocol";
import { ApprovalPrompt } from "./approval-prompt.js";
import { CapabilitiesPanel } from "./capabilities-panel.js";
import { CommandPalette } from "./command-palette.js";
import { ConfigPanel, type ConfigPanelResolved } from "./config-panel.js";
import { CreateCapabilityDialog } from "./create-capability-dialog.js";
import { EventDetailPanel } from "./event-detail.js";
import { HelpPanel } from "./help-panel.js";
import { ModelDialog } from "./model-dialog.js";
import { QuickSwitchDialog } from "./quick-switch-dialog.js";
import { SearchDialog } from "./search-dialog.js";
import { SessionListDialog } from "./session-list-dialog.js";
import { SessionRenameDialog } from "./session-rename-dialog.js";
import { SkillProposalDialog } from "./skill-proposal-dialog.js";
import { SkillReviewDialog } from "./skill-review-dialog.js";
import { StashDialog } from "./stash-dialog.js";
import { TimelineDialog } from "./timeline-dialog.js";
import type { CommandRegistry } from "../lib/commands.js";
import type { CreateCapabilityDraft } from "../lib/create-capability.js";
import type { RunEvent } from "../lib/event-type.js";
import {
  capabilityViewFromPayload,
  createKindFromPayload,
  skillNameFromPayload,
} from "../lib/layer-payload.js";
import type { SessionDiagnostics, SessionSummary } from "../lib/sessions.js";
import type { StashFile } from "../lib/stash.js";
import type {
  TuiSkillProposalInput,
  TuiSkillReviewDetail,
} from "../lib/skill-evolution.js";
import type { LayerEntry } from "../state/layer-stack.js";

export function LayerRenderer(props: {
  entry: LayerEntry;
  registry: CommandRegistry;
  resolved: ConfigPanelResolved;
  sessionList: SessionSummary[];
  currentSessionId: string | null;
  events: RunEvent[];
  labels: Record<string, string>;
  renameTarget: string | null;
  stashList: StashFile["list"];
  effModel?: string;
  modelCandidates: string[];
  sessionDiagnostics: SessionDiagnostics | null;
  loadingDiagnosticsFor: string | null;
  capabilitySnapshot: CapabilitySnapshot | null;
  loadingCapabilities: boolean;
  skillReviewSnapshot: TuiSkillReviewDetail | null;
  loadingSkillReview: boolean;
  onCloseTop: () => void;
  onInspectSession: (id: string) => void;
  onPickSession: (id: string) => void;
  onRequestRename: (id: string) => void;
  onCommitRename: (id: string, label: string) => void;
  onPickStash: (text: string) => void;
  onCommitModel: (model: string) => void;
  onFork: (
    forkAtSequence: number | undefined,
    label: string,
    edit?: boolean,
  ) => void;
  onApprovalDecision: (decision: "approved" | "denied") => void;
  onSearchCopy: (text: string) => void;
  onCreateCapability: (draft: CreateCapabilityDraft) => void;
  onCreateSkillProposal: (draft: TuiSkillProposalInput) => void;
  onUpdateSkillProposal: (draft: TuiSkillProposalInput) => void;
  onApplySkillReviewProposal: (proposalId: string) => void;
  onRejectSkillReviewProposal: (proposalId: string) => void;
}): React.ReactElement | null {
  switch (props.entry.name) {
    case "approval":
      return (
        <ApprovalPrompt
          pending={
            props.entry.payload as React.ComponentProps<
              typeof ApprovalPrompt
            >["pending"]
          }
          onDecision={props.onApprovalDecision}
        />
      );
    case "palette":
      return (
        <CommandPalette
          registry={props.registry}
          onCancel={props.onCloseTop}
          onPick={(command) => {
            props.onCloseTop();
            void command.run();
          }}
        />
      );
    case "sessions":
      return (
        <SessionListDialog
          sessions={props.sessionList}
          labels={props.labels}
          diagnostics={props.sessionDiagnostics}
          loadingDiagnosticsFor={props.loadingDiagnosticsFor}
          onCancel={props.onCloseTop}
          onInspect={props.onInspectSession}
          onPick={props.onPickSession}
          onRename={props.onRequestRename}
        />
      );
    case "quick-switch":
      return (
        <QuickSwitchDialog
          sessions={props.sessionList}
          currentSessionId={props.currentSessionId}
          labels={props.labels}
          onCancel={props.onCloseTop}
          onPick={props.onPickSession}
        />
      );
    case "session-rename":
      if (!props.renameTarget) return null;
      return (
        <SessionRenameDialog
          sessionId={props.renameTarget}
          initialLabel={props.labels[props.renameTarget] ?? ""}
          onCancel={props.onCloseTop}
          onCommit={(label) => props.onCommitRename(props.renameTarget!, label)}
        />
      );
    case "events":
      return (
        <EventDetailPanel events={props.events} onClose={props.onCloseTop} />
      );
    case "stash":
      return (
        <StashDialog
          entries={[...props.stashList].reverse()}
          onCancel={props.onCloseTop}
          onPick={props.onPickStash}
        />
      );
    case "model":
      return (
        <ModelDialog
          model={props.effModel ?? ""}
          candidates={props.modelCandidates}
          onCancel={props.onCloseTop}
          onCommit={props.onCommitModel}
        />
      );
    case "timeline":
      return (
        <TimelineDialog
          events={props.events}
          onCancel={props.onCloseTop}
          onFork={props.onFork}
        />
      );
    case "search":
      return (
        <SearchDialog
          events={props.events}
          onCancel={props.onCloseTop}
          onCopy={props.onSearchCopy}
        />
      );
    case "help":
      return <HelpPanel registry={props.registry} onClose={props.onCloseTop} />;
    case "config":
      return (
        <ConfigPanel resolved={props.resolved} onClose={props.onCloseTop} />
      );
    case "capabilities":
      return (
        <CapabilitiesPanel
          snapshot={props.capabilitySnapshot}
          loading={props.loadingCapabilities}
          view={capabilityViewFromPayload(props.entry.payload)}
          onClose={props.onCloseTop}
        />
      );
    case "create":
      return (
        <CreateCapabilityDialog
          initialKind={createKindFromPayload(props.entry.payload)}
          onCancel={props.onCloseTop}
          onCommit={props.onCreateCapability}
        />
      );
    case "skill-create":
      return (
        <SkillProposalDialog
          action="create"
          onCancel={props.onCloseTop}
          onCommit={props.onCreateSkillProposal}
        />
      );
    case "skill-update":
      return (
        <SkillProposalDialog
          action="update"
          initialName={skillNameFromPayload(props.entry.payload)}
          onCancel={props.onCloseTop}
          onCommit={props.onUpdateSkillProposal}
        />
      );
    case "skill-review":
      return (
        <SkillReviewDialog
          review={props.skillReviewSnapshot}
          loading={props.loadingSkillReview}
          onApply={props.onApplySkillReviewProposal}
          onReject={props.onRejectSkillReviewProposal}
          onCancel={props.onCloseTop}
        />
      );
    default:
      return null;
  }
}
