import { sanitizeAnsiForRender } from "./text.js";

export function formatToolRequestPreview(
  name: string,
  args: unknown,
  max = 80,
): string {
  if (max < 8) return "";
  const r = rec(args);
  if (r && name === "shell") {
    const command = str(r.command);
    return command ? truncatePlain(`$ ${command}`, max) : "";
  }
  if (r && name === "read_file") {
    const path = str(r.path);
    const offset = typeof r.offset === "number" ? `:${r.offset}` : "";
    const limit = typeof r.limit === "number" ? ` +${r.limit}` : "";
    return path ? truncatePlain(`${path}${offset}${limit}`, max) : "";
  }
  if (r && name === "list_dir") {
    const path = str(r.path) || ".";
    const recursive = r.recursive === true ? " recursive" : "";
    return truncatePlain(`${path}${recursive}`, max);
  }
  if (r && name === "glob") {
    const patterns = Array.isArray(r.patterns)
      ? r.patterns.filter((entry) => typeof entry === "string")
      : [];
    return patterns.length > 0
      ? truncatePlain(patterns.slice(0, 3).join(", "), max)
      : "";
  }
  if (r && name === "grep") {
    const pattern = str(r.pattern);
    const path = str(r.path) || str(r.include);
    return truncatePlain([pattern, path].filter(Boolean).join(" in "), max);
  }
  if (r && (name === "create_skill" || name === "update_skill")) {
    const action = str(r.action);
    const skill = str(r.name);
    const force = r.force === true ? " · force" : "";
    return truncatePlain(
      [action, skill].filter(Boolean).join(" ") + force,
      max,
    );
  }
  return args !== undefined ? oneLine(args, max) : "";
}

/** Best-effort one-line preview of a value (object -> compact JSON). */
export function oneLine(value: unknown, max: number): string {
  let s: string;
  if (typeof value === "string") s = value;
  else if (value === undefined || value === null) s = "";
  else {
    try {
      s = JSON.stringify(value) ?? String(value);
    } catch {
      s = String(value);
    }
  }
  s = sanitizeAnsiForRender(s);
  // JSON.stringify escapes ESC as "\u001b", which the raw ANSI sanitizer never
  // sees. Strip those escaped CSI sequences too before folding whitespace.
  s = s.replace(/\\u001b\[[0-9;?]*[a-zA-Z]/g, "");
  s = s
    .replace(/\\[nrt]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return truncatePlain(s, max);
}

function rec(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function str(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function truncatePlain(text: string, max: number): string {
  if (max <= 0) return "";
  return text.length > max ? text.slice(0, Math.max(0, max - 1)) + "…" : text;
}
