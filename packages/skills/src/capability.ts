// AI maintenance note: Bridge between SkillManifest and the core
// CapabilityDescriptor inventory. Capabilities are *descriptions*, not
// authority — registering a skill here just lets product shells list it, not
// invoke it. Execution still flows through tools and policy. Triggers map to
// `tags` so a UI can filter, and the manifest's source path becomes the
// origin name so multiple skills with the same name from different roots can
// be told apart in trace.

import type { CapabilityDescriptor } from "@sparkwright/core";
import type { SkillManifest } from "./types.js";

/**
 * Options for {@link skillsToCapabilities} / {@link skillToCapability}.
 *
 * @public
 * @stability experimental v0.1
 */
export interface SkillCapabilityOptions {
  /** Optional agent id to scope the capability to. */
  agentId?: string;
  /** Prefix for generated capability ids. Default `skill:`. */
  idPrefix?: string;
}

/**
 * Project a single {@link SkillManifest} into a {@link CapabilityDescriptor}.
 *
 * @public
 * @stability experimental v0.1
 */
export function skillToCapability(
  skill: SkillManifest,
  options: SkillCapabilityOptions = {},
): CapabilityDescriptor {
  const prefix = options.idPrefix ?? "skill:";
  const tags = skill.triggers ? [...skill.triggers] : undefined;
  const metadata: Record<string, unknown> = {};
  if (skill.version) metadata.version = skill.version;
  if (skill.examples) metadata.examples = [...skill.examples];
  if (skill.allowedTools) metadata.allowedTools = [...skill.allowedTools];
  if (skill.requiredCapabilities) {
    metadata.requiredCapabilities = [...skill.requiredCapabilities];
  }

  return {
    id: `${prefix}${skill.name}`,
    kind: "skill",
    name: skill.name,
    description: skill.description,
    origin: {
      kind: "skill",
      name: skill.source ?? skill.name,
    },
    enabled: true,
    agentId: options.agentId,
    tags,
    metadata: Object.keys(metadata).length > 0 ? metadata : undefined,
  };
}

/**
 * Project a list of {@link SkillManifest}s into capability descriptors.
 *
 * @public
 * @stability experimental v0.1
 */
export function skillsToCapabilities(
  skills: readonly SkillManifest[],
  options: SkillCapabilityOptions = {},
): CapabilityDescriptor[] {
  return skills.map((skill) => skillToCapability(skill, options));
}
