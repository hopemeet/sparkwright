#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";
import ts from "typescript";

const targets = process.argv.slice(2);
const files =
  targets.length > 0
    ? targets
    : [
        "packages/coding-tools/src/index.ts",
        "packages/host/src/runtime.ts",
        "packages/cli/src/cli.ts",
        "packages/core/src/run.ts",
        "packages/host/src/config.ts",
        "packages/cli/test/cli.test.ts",
      ];

const report = {
  generatedAt: new Date().toISOString(),
  recentWindowDays: 30,
  files: files.map(analyzeFile),
};

console.log(JSON.stringify(report, null, 2));

function analyzeFile(relativePath) {
  const sourceText = readFileSync(relativePath, "utf8");
  const source = ts.createSourceFile(
    relativePath,
    sourceText,
    ts.ScriptTarget.Latest,
    true,
    relativePath.endsWith("x") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  const lineCount = source.getLineAndCharacterOfPosition(source.end).line + 1;
  const functions = [];
  let branchPoints = 0;

  visit(source);

  functions.sort(
    (left, right) =>
      right.lines - left.lines || left.name.localeCompare(right.name),
  );
  const churn = recentChurn(relativePath);
  return {
    path: relativePath,
    lines: lineCount,
    topLevelDeclarations: countTopLevelDeclarations(source),
    branchPoints,
    branchDensityPerKloc: Number(
      ((branchPoints * 1000) / lineCount).toFixed(2),
    ),
    longestFunction: functions[0] ?? null,
    recent30Days: churn,
  };

  function visit(node) {
    if (isBranchPoint(node)) branchPoints += 1;
    if (ts.isFunctionLike(node) && node.body) {
      const start =
        source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
      const end = source.getLineAndCharacterOfPosition(node.end).line + 1;
      functions.push({
        name: functionName(node),
        startLine: start,
        endLine: end,
        lines: end - start + 1,
      });
    }
    ts.forEachChild(node, visit);
  }

  function functionName(node) {
    if (node.name && ts.isIdentifier(node.name)) return node.name.text;
    if (node.name && ts.isStringLiteral(node.name)) return node.name.text;
    if (
      ts.isVariableDeclaration(node.parent) &&
      ts.isIdentifier(node.parent.name)
    ) {
      return node.parent.name.text;
    }
    if (ts.isPropertyAssignment(node.parent))
      return node.parent.name.getText(source);
    return `<anonymous@${source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1}>`;
  }
}

function countTopLevelDeclarations(source) {
  let count = 0;
  for (const statement of source.statements) {
    if (ts.isVariableStatement(statement))
      count += statement.declarationList.declarations.length;
    else if (
      ts.isFunctionDeclaration(statement) ||
      ts.isClassDeclaration(statement) ||
      ts.isInterfaceDeclaration(statement) ||
      ts.isTypeAliasDeclaration(statement) ||
      ts.isEnumDeclaration(statement) ||
      ts.isModuleDeclaration(statement)
    ) {
      count += 1;
    }
  }
  return count;
}

function isBranchPoint(node) {
  if (
    ts.isIfStatement(node) ||
    ts.isConditionalExpression(node) ||
    ts.isForStatement(node) ||
    ts.isForInStatement(node) ||
    ts.isForOfStatement(node) ||
    ts.isWhileStatement(node) ||
    ts.isDoStatement(node) ||
    ts.isCatchClause(node) ||
    ts.isCaseClause(node)
  ) {
    return true;
  }
  return (
    ts.isBinaryExpression(node) &&
    [
      ts.SyntaxKind.AmpersandAmpersandToken,
      ts.SyntaxKind.BarBarToken,
      ts.SyntaxKind.QuestionQuestionToken,
    ].includes(node.operatorToken.kind)
  );
}

function recentChurn(relativePath) {
  const commits = git([
    "log",
    "--since=30 days ago",
    "--format=%H",
    "--",
    relativePath,
  ])
    .split("\n")
    .filter(Boolean);
  const numstat = git([
    "log",
    "--since=30 days ago",
    "--format=",
    "--numstat",
    "--",
    relativePath,
  ]);
  let additions = 0;
  let deletions = 0;
  for (const line of numstat.split("\n")) {
    const [added, deleted] = line.split("\t");
    if (/^\d+$/.test(added ?? "")) additions += Number(added);
    if (/^\d+$/.test(deleted ?? "")) deletions += Number(deleted);
  }
  return { commits: new Set(commits).size, additions, deletions };
}

function git(args) {
  return execFileSync("git", args, { encoding: "utf8" }).trim();
}
