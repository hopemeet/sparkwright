// AI maintenance note: Static guard for externally loaded skills. This is
// intentionally separate from the loader: hosts can inspect manifests before
// registration and apply a trust × severity policy without turning discovery
// into an authority grant.

import {
  createDefaultContentPolicy,
  type ContentPolicy,
} from "@sparkwright/core";
import type { SkillManifest } from "./types.js";
import { extractInlineShellCommands } from "./preprocess.js";

export type SkillTrustLevel =
  | "builtin"
  | "trusted"
  | "community"
  | "agent-created";

export type SkillFindingSeverity = "info" | "caution" | "dangerous";

export interface SkillGuardFinding {
  ruleId: string;
  severity: SkillFindingSeverity;
  message: string;
  /** @reserved Public guard-result field consumed by install UIs. */
  location: "instructions" | "metadata" | "asset" | "manifest";
}

export type SkillGuardDecisionKind = "allow" | "block" | "ask";

export interface SkillGuardDecision {
  kind: SkillGuardDecisionKind;
  findings: SkillGuardFinding[];
  trust: SkillTrustLevel;
}

export interface InspectSkillOptions {
  trust?: SkillTrustLevel;
  force?: boolean;
  policy?: ContentPolicy;
}

const MARKDOWN_REMOTE_SECRET_RE =
  /!?\[[^\]]*]\(https?:\/\/[^)\s]+(?:\$\{?[A-Za-z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|API)[A-Za-z0-9_]*}?)[^)]*\)/i;
const DNS_SECRET_RE =
  /\b(?:dig|nslookup|host)\s+[^\n;|&]*\$\{?[A-Za-z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|API)[A-Za-z0-9_]*}?/i;
const TMP_EXFIL_RE = /\/tmp\/[^\s;&|]+[\s\S]{0,160}\b(?:curl|wget|scp|nc)\b/i;
const DANGEROUS_SCRIPT_ASSET_RE = /(^|\/)scripts\/.*\.(?:sh|bash|zsh|ps1)$/i;
const INLINE_SHELL_MUTATION_RE =
  /(^|[\s;&|()])(?:tee|touch|rm|mv|cp|install|mkdir|rmdir)\b|>>?|(?:fs\.)?(?:writeFile|writeFileSync|appendFile|appendFileSync|copyFile|copyFileSync|rename|renameSync|rm|rmSync|unlink|unlinkSync|mkdir|mkdirSync)\s*\(/i;
const INLINE_SHELL_NETWORK_RE =
  /(^|[\s;&|()])(?:curl|wget|scp|nc|netcat|ssh|sftp|ftp)\b/i;

export function inspectSkill(
  skill: SkillManifest,
  options: InspectSkillOptions = {},
): SkillGuardDecision {
  const trust = options.trust ?? trustFromMetadata(skill);
  if (trust === "builtin") return { kind: "allow", findings: [], trust };

  const policy = options.policy ?? createDefaultContentPolicy();
  const findings: SkillGuardFinding[] = [];
  const policyVerdict = policy.evaluate(skill.instructions, "skill_body");
  for (const block of policyVerdict.blocks) {
    findings.push({
      ruleId: block.ruleId,
      severity: "dangerous",
      message: block.reason,
      location: "instructions",
    });
  }
  for (const warn of policyVerdict.warnings) {
    findings.push({
      ruleId: warn.ruleId,
      severity: "caution",
      message: warn.reason,
      location: "instructions",
    });
  }

  pushPatternFinding(
    findings,
    "markdown_remote_secret",
    MARKDOWN_REMOTE_SECRET_RE,
    skill.instructions,
    "Markdown remote URL interpolates a secret-shaped variable.",
    "dangerous",
  );
  pushPatternFinding(
    findings,
    "dns_secret_exfil",
    DNS_SECRET_RE,
    skill.instructions,
    "DNS lookup command interpolates a secret-shaped variable.",
    "dangerous",
  );
  pushPatternFinding(
    findings,
    "tmp_then_exfil",
    TMP_EXFIL_RE,
    skill.instructions,
    "Skill stages data in /tmp near a network exfiltration command.",
    "caution",
  );

  const inlineShellCommands = extractInlineShellCommands(skill.instructions);
  if (inlineShellCommands.length > 0) {
    findings.push({
      ruleId: "inline_shell_present",
      severity: "caution",
      message:
        "Skill contains inline shell that executes during Skill loading.",
      location: "instructions",
    });
    if (
      inlineShellCommands.some((command) =>
        INLINE_SHELL_MUTATION_RE.test(command),
      )
    ) {
      findings.push({
        ruleId: "inline_shell_mutation",
        severity: "dangerous",
        message:
          "Inline shell appears to mutate local files or directories during Skill loading.",
        location: "instructions",
      });
    }
    if (
      inlineShellCommands.some((command) =>
        INLINE_SHELL_NETWORK_RE.test(command),
      )
    ) {
      findings.push({
        ruleId: "inline_shell_network",
        severity: "dangerous",
        message:
          "Inline shell appears to use network-capable commands during Skill loading.",
        location: "instructions",
      });
    }
  }

  for (const asset of Object.values(skill.assets ?? {}).flat()) {
    if (DANGEROUS_SCRIPT_ASSET_RE.test(asset)) {
      findings.push({
        ruleId: "script_asset",
        severity: "caution",
        message: `Skill includes executable script asset: ${asset}`,
        location: "asset",
      });
    }
  }

  return {
    trust,
    findings,
    kind: decide(trust, findings, Boolean(options.force)),
  };
}

function pushPatternFinding(
  findings: SkillGuardFinding[],
  ruleId: string,
  pattern: RegExp,
  text: string,
  message: string,
  severity: SkillFindingSeverity,
): void {
  if (!pattern.test(text)) return;
  findings.push({ ruleId, severity, message, location: "instructions" });
}

function decide(
  trust: SkillTrustLevel,
  findings: readonly SkillGuardFinding[],
  force: boolean,
): SkillGuardDecisionKind {
  if (force) return "allow";
  if (findings.length === 0) return "allow";
  const hasDangerous = findings.some((f) => f.severity === "dangerous");
  if (trust === "trusted") return hasDangerous ? "block" : "allow";
  if (trust === "community") return "block";
  if (trust === "agent-created") return hasDangerous ? "ask" : "allow";
  return "block";
}

function trustFromMetadata(skill: SkillManifest): SkillTrustLevel {
  const value = skill.metadata?.trust ?? skill.metadata?.trustLevel;
  if (
    value === "builtin" ||
    value === "trusted" ||
    value === "community" ||
    value === "agent-created"
  ) {
    return value;
  }
  return "community";
}
