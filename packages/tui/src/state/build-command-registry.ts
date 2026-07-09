import type { ProjectCommandDescriptor } from "@sparkwright/project-commands";
import { CommandRegistry } from "../lib/commands.js";
import { formatBinding, type Bindings } from "../lib/keybindings.js";
import { toTuiProjectCommands } from "../lib/project-commands.js";
import type { CapabilityView } from "../lib/layer-payload.js";
import type { ActivityTab } from "../lib/task-activity.js";
import type { EventStore } from "./event-store.js";
import type { RunController } from "./run-controller.js";
import type { LayerStack } from "./layer-stack.js";
import type { ToastStore } from "./toast-store.js";
import type { CapabilityActions } from "./use-capability-actions.js";
import type { SessionActions } from "./use-session-actions.js";
import type { SkillActions } from "./use-skill-actions.js";
import type { TaskActions } from "./use-task-actions.js";
import type { WorkflowActions } from "./use-workflow-actions.js";

/**
 * The capability browser is one panel (`openCapabilities`) reached through
 * several named entrypoints that differ only by which view they preselect.
 * Expressed as data so the registry loop registers them uniformly instead of
 * six near-identical `reg.register` blocks.
 */
const CAPABILITY_VIEW_COMMANDS: ReadonlyArray<{
  name: string;
  view: CapabilityView;
  title: string;
  description: string;
  aliases?: string[];
  hiddenByDefault?: boolean;
}> = [
  {
    name: "capabilities",
    view: "all",
    title: "Browse available capabilities",
    description:
      "Discover tools, Skills, MCP servers, agents, and cron support.",
    aliases: ["caps"],
  },
  {
    name: "tools",
    view: "tools",
    title: "Browse tools",
    description: "Show prepared tools, risk, and origin.",
    hiddenByDefault: true,
  },
  {
    name: "skills",
    view: "skills",
    title: "Browse Skills",
    description: "Show Skills SparkWright can discover or load.",
    hiddenByDefault: true,
  },
  {
    name: "agents",
    view: "agents",
    title: "Browse agents",
    description: "Show configured agent profiles.",
    hiddenByDefault: true,
  },
  {
    name: "mcp",
    view: "mcp",
    title: "Browse MCP servers",
    description: "Show configured MCP servers and their exposed tools.",
    hiddenByDefault: true,
  },
  {
    name: "cron",
    view: "cron",
    title: "Browse automation status",
    description: "Show cron jobs and durable background task state.",
    hiddenByDefault: true,
  },
];

/**
 * The activity drawer is one panel (`openActivity`) with two named entrypoints
 * that differ only by which tab they open. Data-driven for the same reason as
 * CAPABILITY_VIEW_COMMANDS above.
 */
const ACTIVITY_COMMANDS: ReadonlyArray<{
  name: string;
  tab: ActivityTab;
  title: string;
  description: string;
  aliases?: string[];
  hintBinding: keyof Bindings;
}> = [
  {
    name: "events",
    tab: "events",
    title: "Open Activity Events",
    description: "Open the activity drawer on the event stream.",
    aliases: ["inspect", "inspector"],
    hintBinding: "events.open",
  },
  {
    name: "tasks",
    tab: "tasks",
    title: "Open Background Tasks",
    description: "Open the activity drawer on durable background tasks.",
    hintBinding: "activity.open",
  },
];

interface BuildCommandRegistryDeps {
  bindings: Bindings;
  layers: LayerStack;
  store: EventStore;
  controller: RunController;
  toasts: ToastStore;
  exit: () => void;
  skillActions: SkillActions;
  capActions: CapabilityActions;
  sessionActions: SessionActions;
  taskActions: Pick<TaskActions, "openActivity">;
  workflowActions: Pick<
    WorkflowActions,
    | "listWorkflows"
    | "attachWorkflow"
    | "startWorkflow"
    | "resumeWorkflow"
    | "stopWorkflow"
  >;
  projectCommands: ProjectCommandDescriptor[];
  runProjectCommand: (
    descriptor: ProjectCommandDescriptor,
    rest: string,
  ) => void;
}

/**
 * Build the slash-command registry. App-level handlers are closed over via
 * `deps` and invoked later through slash input. Kept as a plain builder (App
 * wraps it in a useMemo) so the ~250 lines of command wiring don't sit in the
 * component body.
 */
export function buildCommandRegistry(
  deps: BuildCommandRegistryDeps,
): CommandRegistry {
  const {
    bindings,
    layers,
    store,
    controller,
    toasts,
    exit,
    skillActions,
    capActions,
    sessionActions,
    taskActions,
    workflowActions,
    projectCommands,
    runProjectCommand,
  } = deps;
  const reg = new CommandRegistry();
  reg.register({
    name: "workflow",
    title: "List workflow jobs",
    description: "Show durable workflow jobs in this workspace.",
    category: "workflow",
    aliases: ["workflows"],
    run: () => void workflowActions.listWorkflows(),
    runRaw: (rest) => {
      const [subcommand, ...args] = rest.trim().split(/\s+/).filter(Boolean);
      if (!subcommand || subcommand === "list") {
        void workflowActions.listWorkflows();
        return;
      }
      if (subcommand === "attach") {
        void workflowActions.attachWorkflow(args.join(" "));
        return;
      }
      if (subcommand === "start") {
        void workflowActions.startWorkflow([subcommand, ...args].join(" "));
        return;
      }
      if (subcommand === "resume") {
        void workflowActions.resumeWorkflow(args.join(" "));
        return;
      }
      if (subcommand === "stop") {
        void workflowActions.stopWorkflow(args.join(" "));
        return;
      }
      toasts.push({
        variant: "info",
        title: "workflow",
        message:
          "usage: /workflow list | /workflow attach <id> | /workflow start <name> <goal...> | /workflow resume <id> | /workflow stop <id>",
      });
    },
  });
  reg.register({
    name: "workflow-attach",
    title: "Attach workflow view",
    description: "Open a durable workflow snapshot view.",
    category: "workflow",
    hiddenByDefault: true,
    run: () =>
      toasts.push({
        variant: "info",
        message: "usage: /workflow attach <id>",
      }),
    runRaw: (rest) => void workflowActions.attachWorkflow(rest),
  });
  reg.register({
    name: "help",
    title: "Show keyboard help",
    description: "Toggle the keymap/help panel.",
    category: "view",
    hint: formatBinding(bindings["help.open"]) || undefined,
    run: () => layers.toggle("help"),
  });
  reg.register({
    name: "clear",
    title: "Clear event stream",
    description: "Wipes visible events; keeps session id.",
    category: "view",
    run: () => {
      store.clearEvents();
      toasts.push({ message: "events cleared", variant: "info" });
    },
  });
  reg.register({
    name: "new",
    title: "Start a new session",
    description: "Generates a fresh session id.",
    category: "session",
    run: () => {
      const id = controller.newSession();
      toasts.push({
        title: "new session",
        message: id,
        variant: "success",
      });
    },
  });
  reg.register({
    name: "retry",
    title: "Re-run last goal",
    description: "Submit the most recent goal again in this session.",
    category: "session",
    run: () => {
      void controller.retry().then((ok) => {
        if (ok) return;
        toasts.push({
          title: "nothing to retry",
          message: controller.getLastGoal()
            ? "a run is already active"
            : "no goal has been run yet",
          variant: "info",
        });
      });
    },
  });
  reg.register({
    name: "compact",
    title: "Compact prior context",
    description: "Summarize completed turns for future runs in this session.",
    category: "session",
    run: () => {
      void controller.compactSession().then((result) => {
        if (!result) return;
        if (result.skippedReason) {
          toasts.push({
            variant: "info",
            title: "compact",
            message: result.warnings?.[0]?.message
              ? `${result.skippedReason}: ${result.warnings[0].message}`
              : result.skippedReason,
          });
          return;
        }
        const before = result.originalCharCount;
        const after = result.summaryCharCount;
        const pct =
          before > 0
            ? ` · ${Math.max(0, Math.round((1 - after / before) * 100))}% smaller`
            : "";
        toasts.push({
          variant: "success",
          title: "context compacted",
          message: `${result.compactedRunCount} turn${result.compactedRunCount === 1 ? "" : "s"}${pct}`,
        });
      });
    },
  });
  reg.register({
    name: "sessions",
    title: "Browse past sessions",
    description: "List, inspect diagnostics, resume.",
    category: "session",
    run: () => void sessionActions.openSessionList(),
  });
  for (const spec of ACTIVITY_COMMANDS) {
    reg.register({
      name: spec.name,
      title: spec.title,
      description: spec.description,
      category: "view",
      hint: formatBinding(bindings[spec.hintBinding]) || undefined,
      ...(spec.aliases ? { aliases: spec.aliases } : {}),
      run: () => taskActions.openActivity(spec.tab),
    });
  }
  reg.register({
    name: "config",
    title: "Show resolved config",
    description: "Where each field came from.",
    category: "config",
    run: () => layers.toggle("config"),
  });
  for (const spec of CAPABILITY_VIEW_COMMANDS) {
    reg.register({
      name: spec.name,
      title: spec.title,
      description: spec.description,
      category: "view",
      ...(spec.aliases ? { aliases: spec.aliases } : {}),
      ...(spec.hiddenByDefault ? { hiddenByDefault: true } : {}),
      run: () => void capActions.openCapabilities(spec.view),
    });
  }
  reg.register({
    name: "create",
    title: "Create capability",
    description:
      "Create a Skill, agent, cron job, slash command, or MCP server.",
    category: "capability",
    hiddenByDefault: true,
    run: () => capActions.openCreateCapability(),
    runRaw: (rest) => capActions.openCreateCapability(rest),
  });
  reg.register({
    name: "skill-create",
    title: "Draft Skill proposal",
    description:
      "Create a project Skill proposal interactively or from arguments.",
    category: "capability",
    hiddenByDefault: true,
    run: () => skillActions.openSkillCreateProposal(),
    runRaw: skillActions.openSkillCreateProposal,
  });
  reg.register({
    name: "skill-update",
    title: "Draft Skill update",
    description:
      "Create a hash-gated update/fork proposal interactively or from arguments.",
    category: "capability",
    hiddenByDefault: true,
    run: () => skillActions.openSkillUpdateProposal(),
    runRaw: skillActions.openSkillUpdateProposal,
  });
  reg.register({
    name: "skill-review",
    title: "Review Skill proposals",
    description:
      "Summarize recent Skill proposals; optionally pass a state like draft.",
    category: "capability",
    hiddenByDefault: true,
    run: () => skillActions.reviewSkillProposalsFromSlash(""),
    runRaw: skillActions.reviewSkillProposalsFromSlash,
  });
  reg.register({
    name: "skill-learn",
    title: "Set Skill learning mode",
    description: "Show or set Skill Evolution mode: off, notice, draft, apply.",
    category: "capability",
    hiddenByDefault: true,
    run: () => skillActions.handleSkillLearn(""),
    runRaw: skillActions.handleSkillLearn,
  });
  reg.register({
    name: "model",
    title: "Switch model",
    description: "Change the model reference for the next run.",
    category: "config",
    run: () => layers.toggle("model"),
  });
  reg.register({
    name: "image",
    title: "Attach image",
    description: "Attach a local image to the next submitted goal.",
    category: "capability",
    aliases: ["attach-image"],
    run: () =>
      toasts.push({
        variant: "info",
        title: "image",
        message: "usage: /image <path>",
      }),
    runRaw: (rest) => {
      void controller.attachImage(rest).then((result) => {
        if (!result.ok) {
          toasts.push({
            variant: "error",
            title: "image failed",
            message: result.message,
          });
          return;
        }
        toasts.push({
          variant: "success",
          title: "image attached",
          message: `${result.name} · ${result.count} pending`,
        });
      });
    },
  });
  reg.register({
    name: "clear-images",
    title: "Clear attached images",
    description: "Remove pending image attachments for the next goal.",
    category: "capability",
    hiddenByDefault: true,
    run: () => {
      const count = controller.pendingAttachmentCount();
      controller.clearPendingAttachments();
      toasts.push({
        variant: "info",
        title: "images cleared",
        message: `${count} pending`,
      });
    },
  });
  reg.register({
    name: "fork",
    title: "Fork session at a turn",
    description: "Branch a new session from a chosen point in history.",
    category: "session",
    run: () => layers.toggle("fork"),
  });
  reg.register({
    name: "export",
    title: "Export session transcript",
    description:
      "Render the current session as markdown to .sparkwright/exports/.",
    category: "session",
    run: () => sessionActions.exportTranscript(),
  });
  reg.register({
    name: "rename",
    title: "Rename current session",
    description: "Give the current session a human-friendly label.",
    category: "session",
    run: () => sessionActions.renameCurrentSession(),
  });
  reg.register({
    name: "quit",
    title: "Quit",
    description: "Exit the TUI.",
    category: "system",
    hint: formatBinding(bindings["quit.app"]) || undefined,
    aliases: ["exit", "q"],
    run: () => exit(),
  });
  // File-authored commands last: a built-in of the same name wins because
  // CommandRegistry.register overwrites, and built-ins are the precise layer.
  for (const cmd of toTuiProjectCommands(projectCommands, runProjectCommand)) {
    if (!reg.resolve(cmd.name)) reg.register(cmd);
  }
  return reg;
}
