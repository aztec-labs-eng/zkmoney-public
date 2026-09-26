/**
 * What the built package may reach: its own files, `@obsidion/core` and `@noble/curves`. Anything
 * else in an emitted specifier, a specifier that cannot be read, and any `Buffer` is a leak into a
 * consumer that has neither a node polyfill nor the sdk chain. The emitted files are parsed with
 * the TypeScript compiler, so comments, strings and regexes cannot hide or fake a reference.
 */
import { readdirSync, readFileSync } from "node:fs"
import { dirname, join, resolve, sep } from "node:path"
import ts from "typescript"

export const ALLOWED_PACKAGES: readonly string[] = ["@obsidion/core", "@noble/curves"]

export type IsolationFinding = { file: string; problem: string }

export type ModuleReferences = {
  /** Every string-literal specifier: static imports and re-exports, `import()`, `require()`, `import x = require()`, `import("x").T`. */
  specifiers: string[]
  /** `import()` or `require()` calls whose argument is not a plain string, so nothing can be checked. */
  computed: number
  /** Identifiers named `Buffer`, and `globalThis["Buffer"]`-style lookups. */
  bufferReferences: number
}

const isRequire = (call: ts.CallExpression) =>
  ts.isIdentifier(call.expression) && call.expression.text === "require"
const isDynamicImport = (call: ts.CallExpression) =>
  call.expression.kind === ts.SyntaxKind.ImportKeyword

export function moduleReferences(source: string, fileName: string): ModuleReferences {
  const kind = fileName.endsWith(".ts") ? ts.ScriptKind.TS : ts.ScriptKind.JS
  const file = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, kind)
  const refs: ModuleReferences = { specifiers: [], computed: 0, bufferReferences: 0 }
  // `/// <reference types="…" />` and `/// <reference path="…" />` are dependencies a consumer's
  // typecheck resolves like imports.
  for (const directive of file.typeReferenceDirectives) refs.specifiers.push(directive.fileName)
  for (const directive of file.referencedFiles) refs.specifiers.push(`./${directive.fileName}`)
  const visit = (node: ts.Node): void => {
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier &&
      ts.isStringLiteral(node.moduleSpecifier)
    ) {
      refs.specifiers.push(node.moduleSpecifier.text)
    } else if (
      ts.isImportEqualsDeclaration(node) &&
      ts.isExternalModuleReference(node.moduleReference) &&
      ts.isStringLiteral(node.moduleReference.expression)
    ) {
      refs.specifiers.push(node.moduleReference.expression.text)
    } else if (ts.isImportTypeNode(node)) {
      const literal = ts.isLiteralTypeNode(node.argument) ? node.argument.literal : undefined
      if (literal && ts.isStringLiteral(literal)) refs.specifiers.push(literal.text)
      else refs.computed++
    } else if (ts.isCallExpression(node) && (isDynamicImport(node) || isRequire(node))) {
      const argument = node.arguments[0]
      if (argument && ts.isStringLiteralLike(argument)) refs.specifiers.push(argument.text)
      else refs.computed++
    } else if (ts.isIdentifier(node) && node.text === "Buffer") {
      refs.bufferReferences++
    } else if (
      ts.isElementAccessExpression(node) &&
      ts.isStringLiteralLike(node.argumentExpression) &&
      node.argumentExpression.text === "Buffer"
    ) {
      refs.bufferReferences++
    }
    ts.forEachChild(node, visit)
  }
  visit(file)
  return refs
}

/** Emitted code and declarations: a type-only import erased from the `.js` still ships in the `.d.ts`. */
function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) walk(path, out)
    else if (entry.name.endsWith(".js") || entry.name.endsWith(".d.ts")) out.push(path)
  }
  return out
}

/** Findings over every emitted file under `distDir`; an empty list means the build is isolated. */
export function checkIsolation(distDir: string): IsolationFinding[] {
  const root = resolve(distDir)
  const inside = (path: string) => path === root || path.startsWith(root + sep)
  const findings: IsolationFinding[] = []
  for (const file of walk(root)) {
    const refs = moduleReferences(readFileSync(file, "utf8"), file)
    for (const spec of refs.specifiers) {
      if (spec.startsWith(".")) {
        if (!inside(resolve(dirname(file), spec))) {
          findings.push({ file, problem: `relative import escapes dist: ${spec}` })
        }
      } else if (!ALLOWED_PACKAGES.some((pkg) => spec === pkg || spec.startsWith(`${pkg}/`))) {
        findings.push({ file, problem: `import outside the allowlist: ${spec}` })
      }
    }
    if (refs.computed > 0) {
      findings.push({ file, problem: "dynamic import or require with a computed specifier" })
    }
    if (refs.bufferReferences > 0) {
      findings.push({ file, problem: "references the node Buffer global" })
    }
  }
  return findings
}
