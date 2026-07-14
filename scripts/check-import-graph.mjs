#!/usr/bin/env node
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const workspaceManifests = discoverWorkspaceManifests();
const packagesByName = new Map(
  workspaceManifests.map((relativePath) => {
    const manifest = JSON.parse(
      readFileSync(path.join(root, relativePath), "utf8"),
    );
    return [manifest.name, { dir: path.dirname(relativePath), manifest }];
  }),
);
const sourceFiles = workspaceManifests.flatMap((manifestPath) =>
  walkSource(path.join(root, path.dirname(manifestPath), "src")),
);
const sourceSet = new Set(sourceFiles);
const valueGraph = new Map(sourceFiles.map((file) => [file, new Set()]));
const typeGraph = new Map(sourceFiles.map((file) => [file, new Set()]));

const FACADE_IMPORT_ALLOWLIST = new Map([
  [
    "packages/host/src/runtime.ts",
    new Set([
      "packages/host/src/index.ts",
      "packages/host/src/host-service.ts",
      "packages/host/src/server.ts",
      "packages/host/src/im-control.ts",
    ]),
  ],
  ["packages/cli/src/cli.ts", new Set(["packages/cli/src/index.ts"])],
  [
    "packages/core/src/run.ts",
    new Set(["packages/core/src/index.ts", "packages/core/src/internal.ts"]),
  ],
  ["packages/coding-tools/src/index.ts", new Set()],
  [
    "packages/host/src/config.ts",
    new Set([
      "packages/host/src/index.ts",
      "packages/host/src/runtime.ts",
      "packages/host/src/model-builder.ts",
      "packages/host/src/model-factory.ts",
      "packages/host/src/workflow-node-api.ts",
      "packages/host/src/delegate-runner.ts",
      "packages/host/src/run-input-validation.ts",
      "packages/host/src/active-rules.ts",
      "packages/host/src/verification.ts",
      "packages/host/src/indexed-delegate-tool.ts",
      "packages/host/src/workflow-projection.ts",
      "packages/host/src/tools.ts",
      "packages/host/src/run-policy.ts",
      "packages/host/src/invariant-projection.ts",
      "packages/host/src/run-security-plan.ts",
      "packages/host/src/session-compaction.ts",
      "packages/host/src/workflow-hooks.ts",
      "packages/host/src/delegate-capability.ts",
      "packages/host/src/tool-catalog.ts",
    ]),
  ],
]);

const facadeViolations = [];
let valueEdges = 0;
let typeEdges = 0;

for (const file of sourceFiles) {
  const sourceText = readFileSync(file, "utf8");
  const source = ts.createSourceFile(
    file,
    sourceText,
    ts.ScriptTarget.Latest,
    true,
  );
  for (const dependency of importsFrom(source)) {
    const target = resolveImport(file, dependency.specifier);
    if (!target || !sourceSet.has(target)) continue;
    const graph = dependency.typeOnly ? typeGraph : valueGraph;
    graph.get(file).add(target);
    if (dependency.typeOnly) typeEdges += 1;
    else valueEdges += 1;
    checkFacadeImport(file, target, dependency);
  }
}

const valueCycles = stronglyConnectedComponents(valueGraph).filter(isCycle);
const typeCycles = stronglyConnectedComponents(typeGraph).filter(isCycle);

if (valueCycles.length > 0 || facadeViolations.length > 0) {
  if (valueCycles.length > 0) {
    console.error("Runtime value-import cycles:");
    for (const cycle of valueCycles) console.error(`- ${formatCycle(cycle)}`);
  }
  if (facadeViolations.length > 0) {
    console.error("Implementation-to-facade imports:");
    for (const violation of facadeViolations) console.error(`- ${violation}`);
  }
  process.exit(1);
}

console.log(
  `Import graph OK: ${sourceFiles.length} source files, ${valueEdges} value edges, ${typeEdges} type-only edges, 0 value SCCs.`,
);
if (typeCycles.length > 0) {
  console.log(`Type-only SCCs (informational): ${typeCycles.length}`);
  for (const cycle of typeCycles) console.log(`- ${formatCycle(cycle)}`);
} else {
  console.log("Type-only SCCs (informational): 0");
}

function discoverWorkspaceManifests() {
  const rootManifest = JSON.parse(
    readFileSync(path.join(root, "package.json"), "utf8"),
  );
  const patterns = Array.isArray(rootManifest.workspaces)
    ? rootManifest.workspaces
    : (rootManifest.workspaces?.packages ?? []);
  const manifests = [];
  for (const pattern of patterns) {
    if (pattern.endsWith("/*")) {
      const parent = path.join(root, pattern.slice(0, -2));
      for (const entry of readdirSync(parent, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        const manifest = path.join(parent, entry.name, "package.json");
        if (existsSync(manifest)) manifests.push(toRelative(manifest));
      }
    } else {
      const manifest = path.join(root, pattern, "package.json");
      if (!existsSync(manifest))
        throw new Error(
          `Workspace manifest not found: ${pattern}/package.json`,
        );
      manifests.push(toRelative(manifest));
    }
  }
  return manifests.sort();
}

function walkSource(dir) {
  if (!existsSync(dir)) return [];
  const result = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) result.push(...walkSource(full));
    else if (
      entry.isFile() &&
      /\.(?:[cm]?ts|tsx|[cm]?js|jsx)$/.test(entry.name) &&
      !entry.name.endsWith(".d.ts")
    ) {
      result.push(path.resolve(full));
    }
  }
  return result;
}

function* importsFrom(source) {
  for (const statement of source.statements) {
    if (
      ts.isImportDeclaration(statement) &&
      ts.isStringLiteral(statement.moduleSpecifier)
    ) {
      const clause = statement.importClause;
      const namedBindings = clause?.namedBindings;
      const namedTypeOnly =
        namedBindings &&
        ts.isNamedImports(namedBindings) &&
        namedBindings.elements.length > 0 &&
        namedBindings.elements.every((element) => element.isTypeOnly);
      yield {
        specifier: statement.moduleSpecifier.text,
        typeOnly: Boolean(
          clause?.isTypeOnly || (!clause?.name && namedTypeOnly),
        ),
        line:
          source.getLineAndCharacterOfPosition(statement.getStart(source))
            .line + 1,
      };
    } else if (
      ts.isExportDeclaration(statement) &&
      statement.moduleSpecifier &&
      ts.isStringLiteral(statement.moduleSpecifier)
    ) {
      const namedTypeOnly =
        statement.exportClause &&
        ts.isNamedExports(statement.exportClause) &&
        statement.exportClause.elements.length > 0 &&
        statement.exportClause.elements.every((element) => element.isTypeOnly);
      yield {
        specifier: statement.moduleSpecifier.text,
        typeOnly: Boolean(statement.isTypeOnly || namedTypeOnly),
        line:
          source.getLineAndCharacterOfPosition(statement.getStart(source))
            .line + 1,
      };
    }
  }
  const visit = (node) => {
    if (
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword &&
      node.arguments.length === 1 &&
      ts.isStringLiteral(node.arguments[0])
    ) {
      dynamic.push({
        specifier: node.arguments[0].text,
        typeOnly: false,
        line:
          source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1,
      });
    }
    ts.forEachChild(node, visit);
  };
  const dynamic = [];
  ts.forEachChild(source, visit);
  yield* dynamic;
}

function resolveImport(fromFile, specifier) {
  if (specifier.startsWith("."))
    return resolveModulePath(path.resolve(path.dirname(fromFile), specifier));
  const packageName = specifier.startsWith("@")
    ? specifier.split("/").slice(0, 2).join("/")
    : specifier.split("/")[0];
  const workspace = packagesByName.get(packageName);
  if (!workspace) return null;
  const subpath = specifier.slice(packageName.length).replace(/^\//, "");
  const base = path.join(root, workspace.dir, "src", subpath || "index");
  return resolveModulePath(base);
}

function resolveModulePath(base) {
  const withoutJs = base.replace(/\.(?:[cm]?js|jsx)$/, "");
  for (const candidate of [
    base,
    withoutJs,
    `${withoutJs}.ts`,
    `${withoutJs}.tsx`,
    `${withoutJs}.mts`,
    `${withoutJs}.cts`,
    path.join(withoutJs, "index.ts"),
    path.join(withoutJs, "index.tsx"),
  ]) {
    if (existsSync(candidate) && statSync(candidate).isFile())
      return path.resolve(candidate);
  }
  return null;
}

function checkFacadeImport(fromFile, target, dependency) {
  const facade = toRelative(target);
  const allowlist = FACADE_IMPORT_ALLOWLIST.get(facade);
  if (!allowlist) return;
  const importer = toRelative(fromFile);
  if (
    path.dirname(importer).split("/").slice(0, 3).join("/") !==
    path.dirname(facade).split("/").slice(0, 3).join("/")
  )
    return;
  if (allowlist.has(importer)) return;
  facadeViolations.push(`${importer}:${dependency.line} imports ${facade}`);
}

function stronglyConnectedComponents(graph) {
  let index = 0;
  const indices = new Map();
  const lowlinks = new Map();
  const stack = [];
  const onStack = new Set();
  const components = [];
  for (const node of graph.keys()) if (!indices.has(node)) connect(node);
  return components;

  function connect(node) {
    indices.set(node, index);
    lowlinks.set(node, index);
    index += 1;
    stack.push(node);
    onStack.add(node);
    for (const target of graph.get(node) ?? []) {
      if (!indices.has(target)) {
        connect(target);
        lowlinks.set(node, Math.min(lowlinks.get(node), lowlinks.get(target)));
      } else if (onStack.has(target)) {
        lowlinks.set(node, Math.min(lowlinks.get(node), indices.get(target)));
      }
    }
    if (lowlinks.get(node) === indices.get(node)) {
      const component = [];
      let current;
      do {
        current = stack.pop();
        onStack.delete(current);
        component.push(current);
      } while (current !== node);
      components.push(component);
    }
  }
}

function isCycle(component) {
  return (
    component.length > 1 || valueGraph.get(component[0])?.has(component[0])
  );
}

function formatCycle(component) {
  return component.map(toRelative).sort().join(" -> ");
}

function toRelative(file) {
  return path.relative(root, file).split(path.sep).join("/");
}
