import {
  createHostService,
  type HostRuntimeFacadeOptions,
} from "../../src/host-service.js";
import type { HostRuntime } from "../../src/runtime.js";
import { createAutoTrustProjectTrustManager } from "./project-trust.js";

/** Create a fully composed runtime through the canonical process service. */
export function createTestHostRuntime(
  options: HostRuntimeFacadeOptions,
): HostRuntime {
  return createHostService({
    projectTrust: createAutoTrustProjectTrustManager(),
  }).createRuntime(options);
}
