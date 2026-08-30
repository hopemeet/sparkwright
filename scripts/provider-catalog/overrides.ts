import type { GeneratedCatalogModel } from "./lib.js";

/**
 * Code-reviewed model identity corrections applied after external normalization.
 * Keep this metadata-only: no endpoints, packages, credentials, or drivers.
 */
export const CATALOG_MODEL_ADDITIONS: Readonly<
  Record<string, readonly GeneratedCatalogModel[]>
> = {
  google: [
    { id: "gemini-3-flash", displayName: "gemini-3-flash" },
    { id: "gemini-3.1-pro", displayName: "gemini-3.1-pro" },
  ],
};
