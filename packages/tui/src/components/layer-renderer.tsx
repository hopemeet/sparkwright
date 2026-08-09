import React from "react";
import type {
  CapabilitySnapshot,
  ProviderCatalogSnapshot,
  ProviderAuthMethodsSnapshot,
  ProviderConnectionSummary,
  ProjectTrustSnapshot,
  SessionForkPoint,
  TaskOutputChunkSnapshot,
  TaskRecordSnapshot,
  WorkflowRunSnapshot,
} from "@sparkwright/protocol";
import { ActivityPanel, type ActivityTab } from "./activity-panel.js";
import { ApprovalPrompt } from "./approval-prompt.js";
import { CapabilitiesPanel } from "./capabilities-panel.js";
import { ConfigPanel, type ConfigPanelResolved } from "./config-panel.js";
import { CreateCapabilityDialog } from "./create-capability-dialog.js";
import { HelpPanel } from "./help-panel.js";
import { ModelDialog } from "./model-dialog.js";
import { ConnectDialog } from "./connect-dialog.js";
import { NotificationPanel } from "./notification-panel.js";
import { SessionListDialog } from "./session-list-dialog.js";
import { SessionRenameDialog } from "./session-rename-dialog.js";
import { SkillsPanel } from "./skills-panel.js";
import { WorkflowPanel } from "./workflow-panel.js";
import { ForkDialog } from "./fork-dialog.js";
import { ProjectTrustDialog } from "./project-trust-dialog.js";
import type { CommandRegistry } from "../lib/commands.js";
import type { Bindings } from "../lib/keybindings.js";
import type { CreateCapabilityDraft } from "../lib/create-capability.js";
import type { RunEvent } from "../lib/event-type.js";
import type { ApprovalChoice } from "../lib/session-approval.js";
import type { SessionDiagnostics, SessionSummary } from "../lib/sessions.js";
import type { LayerEntry } from "../state/layer-stack.js";
import type { UiSignal } from "../lib/ui-signal.js";
import type { UsageSummary } from "../state/event-store.js";
import type { TuiSkillsBrowserSnapshot } from "../lib/skills-browser.js";

export function LayerRenderer(props: {
  entry: LayerEntry;
  registry: CommandRegistry;
  bindings: Bindings;
  resolved: ConfigPanelResolved;
  sessionList: SessionSummary[];
  sessionRootLabel?: string;
  events: RunEvent[];
  usage?: UsageSummary | null;
  taskRecords?: readonly TaskRecordSnapshot[];
  taskOutputs?: Readonly<Record<string, readonly TaskOutputChunkSnapshot[]>>;
  loadingTasks?: boolean;
  workflows?: readonly WorkflowRunSnapshot[];
  loadingWorkflows?: boolean;
  selectedWorkflowId?: string;
  ownedWorkflowRunIds?: ReadonlySet<string>;
  ownedRunIds?: ReadonlySet<string>;
  labels: Record<string, string>;
  renameTarget: string | null;
  effModel?: string;
  modelCandidates: string[];
  providerCatalog: ProviderCatalogSnapshot | null;
  loadingProviders: boolean;
  projectTrust: ProjectTrustSnapshot | null;
  loadingProjectTrust: boolean;
  sessionDiagnostics: SessionDiagnostics | null;
  loadingDiagnosticsFor: string | null;
  capabilitySnapshot: CapabilitySnapshot | null;
  loadingCapabilities: boolean;
  skillsSnapshot: TuiSkillsBrowserSnapshot | null;
  loadingSkills: boolean;
  notifications: readonly UiSignal[];
  onCloseTop: () => void;
  onActivityTabChange?: (tab: ActivityTab) => void;
  onRefreshTasks?: () => void;
  onStopTask?: (taskId: string) => void;
  onJoinTask?: (taskId: string) => void;
  onPromoteTask?: (taskId: string) => void;
  onRefreshWorkflows?: () => void;
  onSelectWorkflow?: (id: string) => void;
  onInspectSession: (id: string) => void;
  onPickSession: (id: string) => void;
  onRequestRename: (id: string) => void;
  onCommitRename: (id: string, label: string) => void;
  onCommitModel: (model: string) => void;
  onProviderAuth: (
    action: "login" | "logout" | "refresh",
    profileId: string,
  ) => void;
  onLoadProviderAuthMethods: (
    providerId: string,
  ) => Promise<ProviderAuthMethodsSnapshot | null>;
  onSubmitProviderSecret: (
    providerId: string,
    methodId: string,
    secret: string,
  ) => Promise<ProviderConnectionSummary | null>;
  onRefreshProviderCatalog: () => Promise<ProviderCatalogSnapshot | null>;
  onGrantProjectTrust: (expectedManifestHash: string) => void;
  onRevokeProjectTrust: () => void;
  onFork: (
    forkPoint: SessionForkPoint | undefined,
    label: string,
    edit?: boolean,
  ) => void;
  onApprovalDecision: (choice: ApprovalChoice) => void;
  onCreateCapability: (draft: CreateCapabilityDraft) => void;
}): React.ReactElement | null {
  const entry = props.entry;
  switch (entry.name) {
    case "approval":
      return (
        <ApprovalPrompt
          pending={entry.payload}
          onDecision={props.onApprovalDecision}
        />
      );
    case "sessions":
      return (
        <SessionListDialog
          sessions={props.sessionList}
          sessionRootLabel={props.sessionRootLabel}
          labels={props.labels}
          diagnostics={props.sessionDiagnostics}
          loadingDiagnosticsFor={props.loadingDiagnosticsFor}
          onCancel={props.onCloseTop}
          onInspect={props.onInspectSession}
          onPick={props.onPickSession}
          onRename={props.onRequestRename}
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
    case "activity":
      return (
        <ActivityPanel
          events={props.events}
          usage={props.usage}
          taskRecords={props.taskRecords}
          taskOutputs={props.taskOutputs}
          loadingTasks={props.loadingTasks}
          initialTab={entry.payload.tab}
          onClose={props.onCloseTop}
          onTabChange={props.onActivityTabChange}
          onRefreshTasks={props.onRefreshTasks}
          onStopTask={props.onStopTask}
          onJoinTask={props.onJoinTask}
          onPromoteTask={props.onPromoteTask}
        />
      );
    case "model":
      return (
        <ModelDialog
          model={props.effModel ?? ""}
          candidates={props.modelCandidates}
          catalog={props.providerCatalog}
          loading={props.loadingProviders}
          onCancel={props.onCloseTop}
          onCommit={props.onCommitModel}
          onAuth={props.onProviderAuth}
        />
      );
    case "connect":
      return (
        <ConnectDialog
          catalog={props.providerCatalog}
          loading={props.loadingProviders}
          onLoadMethods={props.onLoadProviderAuthMethods}
          onSubmitSecret={props.onSubmitProviderSecret}
          onRefresh={props.onRefreshProviderCatalog}
          onCommitModel={props.onCommitModel}
          onCancel={props.onCloseTop}
        />
      );
    case "trust":
      return (
        <ProjectTrustDialog
          snapshot={props.projectTrust}
          loading={props.loadingProjectTrust}
          onGrant={props.onGrantProjectTrust}
          onRevoke={props.onRevokeProjectTrust}
          onClose={props.onCloseTop}
        />
      );
    case "workflow":
      return (
        <WorkflowPanel
          workflows={props.workflows ?? []}
          selectedWorkflowId={props.selectedWorkflowId}
          loading={Boolean(props.loadingWorkflows)}
          ownedWorkflowRunIds={props.ownedWorkflowRunIds}
          ownedRunIds={props.ownedRunIds}
          onClose={props.onCloseTop}
          onRefresh={() => props.onRefreshWorkflows?.()}
          onSelect={(id) => props.onSelectWorkflow?.(id)}
        />
      );
    case "fork":
      return (
        <ForkDialog
          events={props.events}
          onCancel={props.onCloseTop}
          onFork={props.onFork}
        />
      );
    case "help":
      return (
        <HelpPanel
          registry={props.registry}
          bindings={props.bindings}
          onClose={props.onCloseTop}
        />
      );
    case "config":
      return (
        <ConfigPanel resolved={props.resolved} onClose={props.onCloseTop} />
      );
    case "notifications":
      return (
        <NotificationPanel
          signals={props.notifications}
          onClose={props.onCloseTop}
        />
      );
    case "capabilities":
      if (entry.payload.view === "skills") {
        return (
          <SkillsPanel
            snapshot={props.skillsSnapshot}
            loading={props.loadingSkills}
            workspaceRoot={props.resolved.workspaceRoot}
            onClose={props.onCloseTop}
          />
        );
      }
      return (
        <CapabilitiesPanel
          snapshot={props.capabilitySnapshot}
          loading={props.loadingCapabilities}
          view={entry.payload.view}
          workspaceRoot={props.resolved.workspaceRoot}
          onClose={props.onCloseTop}
        />
      );
    case "create":
      return (
        <CreateCapabilityDialog
          initialKind={entry.payload.kind}
          onCancel={props.onCloseTop}
          onCommit={props.onCreateCapability}
        />
      );
    default:
      return null;
  }
}
