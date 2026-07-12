import { resolve } from "node:path";
import type { CapabilityPackageMutationReporter } from "./capability-package-mutation.js";
import {
  applyApprovedSkillProposal,
  createSkillCreateProposal,
  listSkillProposals,
  prepareSkillProposalApproval,
  readSkillProposal,
  recordSkillProposalApproval,
  reviseSkillProposalDraft,
  type ApplySkillProposalResult,
  type PreparedSkillApproval,
  type SkillApprovalReceipt,
  type SkillProposalContentMode,
  type SkillProposalDetail,
  type SkillProposalProvenance,
} from "./skill-evolution.js";
import { projectSkillRoot } from "./skill-roots.js";

export type SkillCreateEligibility =
  | "quick_apply"
  | "review_required"
  | "force_required";

export interface PrepareSkillCreateCommandInput {
  name: string;
  description: string;
  content?: string;
  root?: string;
  provenance?: SkillProposalProvenance;
  mutationReporter?: CapabilityPackageMutationReporter;
}

export interface PrepareSkillCreateCommandResult {
  proposal: SkillProposalDetail;
  changed: boolean;
  existing: boolean;
  revised: boolean;
  eligibility: SkillCreateEligibility;
  contentMode: SkillProposalContentMode;
}

export interface ApprovePreparedSkillResult {
  approval: SkillApprovalReceipt;
  applied: ApplySkillProposalResult;
}

/**
 * Host-owned command boundary for human/model Skill creation entrypoints.
 * Product adapters parse input and render output; this service owns proposal
 * dedupe, prepared-effect authorization, and apply/resume semantics.
 */
export class SkillCommandService {
  constructor(private readonly workspaceRoot: string) {}

  async prepareCreate(
    input: PrepareSkillCreateCommandInput,
  ): Promise<PrepareSkillCreateCommandResult> {
    this.assertProjectRoot(input.root);
    const existing = await this.findExistingCreateDraft(
      input.name,
      input.provenance,
    );
    if (existing) {
      const revised = await reviseSkillProposalDraft({
        workspaceRoot: this.workspaceRoot,
        proposalId: existing.id,
        description: input.description,
        content: input.content,
        provenance: input.provenance,
        mutationReporter: input.mutationReporter,
      });
      return this.createResult(revised.proposal, {
        changed: revised.changed,
        existing: true,
        revised: revised.changed,
      });
    }

    const proposal = await createSkillCreateProposal({
      workspaceRoot: this.workspaceRoot,
      name: input.name,
      description: input.description,
      content: input.content,
      provenance: input.provenance,
      mutationReporter: input.mutationReporter,
    });
    return this.createResult(proposal, {
      changed: true,
      existing: false,
      revised: false,
    });
  }

  prepareApproval(proposalId: string): Promise<PreparedSkillApproval> {
    return prepareSkillProposalApproval(this.workspaceRoot, proposalId);
  }

  async approvePrepared(
    prepared: PreparedSkillApproval,
    options: { force?: boolean } = {},
  ): Promise<ApprovePreparedSkillResult> {
    const approval = await recordSkillProposalApproval({
      workspaceRoot: this.workspaceRoot,
      proposalId: prepared.proposal.id,
      effectHash: prepared.effectHash,
    });
    const applied = await applyApprovedSkillProposal(
      this.workspaceRoot,
      prepared.proposal.id,
      { force: options.force },
    );
    return { approval, applied };
  }

  async approveAndApply(
    proposalId: string,
    options: { force?: boolean } = {},
  ): Promise<ApprovePreparedSkillResult> {
    const prepared = await this.prepareApproval(proposalId);
    return this.approvePrepared(prepared, options);
  }

  private async findExistingCreateDraft(
    skillName: string,
    provenance: SkillProposalProvenance | undefined,
  ): Promise<SkillProposalDetail | undefined> {
    const sessionId = provenance?.sessionId?.trim();
    const runId = provenance?.runId?.trim();
    const proposals = await listSkillProposals(this.workspaceRoot);
    const candidates = proposals.filter(
      (proposal) =>
        proposal.kind === "create" &&
        proposal.state === "draft" &&
        proposal.skillName === skillName,
    );
    const match =
      candidates.find((proposal) =>
        sessionId
          ? proposal.provenance?.sessionId === sessionId
          : runId
            ? proposal.provenance?.runId === runId
            : proposal.provenance === undefined,
      ) ?? candidates[0];
    if (!match) return undefined;
    return readSkillProposal(this.workspaceRoot, match.id);
  }

  private createResult(
    proposal: SkillProposalDetail,
    state: Pick<
      PrepareSkillCreateCommandResult,
      "changed" | "existing" | "revised"
    >,
  ): PrepareSkillCreateCommandResult {
    const contentMode = proposal.contentMode ?? "template";
    const hasDangerous = proposal.guardFindings?.some(
      (finding) => finding.severity === "dangerous",
    );
    const eligibility: SkillCreateEligibility = hasDangerous
      ? "force_required"
      : contentMode === "authored" &&
          (proposal.guardFindings?.length ?? 0) === 0
        ? "quick_apply"
        : "review_required";
    return { proposal, contentMode, eligibility, ...state };
  }

  private assertProjectRoot(root: string | undefined): void {
    if (!root) return;
    const requested = resolve(this.workspaceRoot, root);
    const project = resolve(projectSkillRoot(this.workspaceRoot));
    if (requested !== project) {
      throw new Error(
        "Managed Skill creation only supports the project root .sparkwright/skills.",
      );
    }
  }
}
