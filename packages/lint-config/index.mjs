// The one criterion for code migrated to the wallet's rules (docs/conventions/wallet-architecture.md):
// ESLint rules plus the repo's Prettier format, reported by one `eslint` run. Each package passes the paths it has
// migrated; a slice grows those lists and never weakens the rules.
import path from "node:path"
import js from "@eslint/js"
import prettier from "eslint-plugin-prettier"
import reactHooks from "eslint-plugin-react-hooks"
import tseslint from "typescript-eslint"
import { repoPath, storeSites } from "./legacyStores.mjs"

// A rejection handler swallows when its body is empty, or when it only yields a value without
// reading its error (local/no-swallow). `(e) => e` hands the error on.
const HANDLERS = [
  "CallExpression[callee.property.name='catch'] > :matches(ArrowFunctionExpression, FunctionExpression)",
  "CallExpression[callee.property.name='then'] > :matches(ArrowFunctionExpression, FunctionExpression):nth-child(2)",
]
const SWALLOWED = "Convert, show or rethrow the error, or log it with bestEffort, instead of dropping it."
const VALUE = /^(Literal|Identifier|MemberExpression|ObjectExpression|ArrayExpression|TemplateLiteral)$/
const NO_SWALLOW = [
  ...HANDLERS.map((handler) => ({
    selector: `${handler}[body.type='BlockStatement'][body.body.length=0]`,
    message: SWALLOWED,
  })),
  // `no-empty` lets a comment fill a catch.
  {
    selector: "CatchClause > BlockStatement.body[body.length=0]",
    message: "Log the error with bestEffort or bestEffortSync, instead of leaving the catch empty.",
  },
]
const THROWN = "Throw a WalletError with a code from the closed set, not a built-in Error."
const BUILTIN_ERRORS =
  "/^(Error|TypeError|RangeError|SyntaxError|ReferenceError|EvalError|URIError|AggregateError|DOMException)$/"
// A throw, or a rejection through `Promise.reject` or a `reject` callback.
const NO_THROW = [
  "ThrowStatement",
  "CallExpression[callee.name='reject']",
  "CallExpression[callee.property.name='reject']",
].flatMap((site) =>
  ["NewExpression", "CallExpression"].map((made) => ({
    selector: `${site} > ${made}[callee.name=${BUILTIN_ERRORS}]`,
    message: THROWN,
  })),
)
const NO_MODULE_MOCKS = {
  selector: "CallExpression[callee.object.name='vi'][callee.property.name=/^(mock|doMock)$/]",
  message: "Pass an in-memory fake of the module's public interface, instead of mocking the module.",
}
// A negated matcher asserts absence, as a privacy check does, so it pins no wording.
const MATCHER =
  "CallExpression[callee.property.name=/^(toBe|toEqual|toStrictEqual|toContain|toContainEqual|toMatch|toMatchObject|toThrow|toThrowError|toHaveProperty|toHaveTextContent)$/]" +
  ":not([callee.object.property.name='not'])"
// `expect.objectContaining(…)` and its kin; `expect.not.…` is negated.
const ASYMMETRIC =
  "CallExpression[callee.object.name='expect'][callee.property.name=/^(objectContaining|arrayContaining|stringContaining|stringMatching)$/]"
const copy = (target) => ({
  selector: [MATCHER, ASYMMETRIC]
    .flatMap((m) => [`${m} > ${target}`, `${m} > :matches(ObjectExpression, ArrayExpression) ${target}`])
    .join(", "),
  message: "Assert through the constant or error code that owns this copy, not a literal string.",
})
// Prose is a literal with a space.
const NO_COPY = [
  copy("Literal[value=/\\s/]"),
  copy("Literal[regex.pattern=/ /]"),
  copy("TemplateLiteral:has(TemplateElement[value.raw=/\\s/])"),
]
const COPY_ATTR = "JSXAttribute[name.name=/^(title|label|placeholder|aria-label|alt)$/]"
// Preamble "Storage": only platform storage touches browser storage or walletStorage's copy.
const STORAGE = "Keep this data in a persistent store on the Database, or use the platform storage helpers."
const STORAGE_GLOBALS = ["localStorage", "sessionStorage", "indexedDB"]
const STORAGE_IMPORTS = {
  group: ["**/walletStorage", "**/walletStorage.js"],
  importNames: ["walletStorage"],
  message: STORAGE,
}
const NO_STORAGE_IMPORT = { selector: "ImportExpression[source.value=/walletStorage/]", message: STORAGE }
const STORAGE_RULES = {
  "no-restricted-globals": ["error", ...STORAGE_GLOBALS.map((name) => ({ name, message: STORAGE }))],
  "no-restricted-properties": [
    "error",
    ...["window", "globalThis", "self"].flatMap((object) =>
      STORAGE_GLOBALS.map((property) => ({ object, property, message: STORAGE })),
    ),
  ],
}
// The effect debt rule finds React's effect hooks by their import from react, so no module hands
// them on under another name.
const HOOKS = "/^(useState|useReducer|useEffect|useLayoutEffect|useInsertionEffect)$/"
// A local binding handed on: a hook, or React itself under its usual name.
const HANDED_ON = "/^(React|useState|useReducer|useEffect|useLayoutEffect|useInsertionEffect)$/"
const HOOK_ALIAS = "Import React's state and effect hooks from react where you call them, and never re-export or alias them."
const hookBan = (selector) => ({
  selector,
  message: HOOK_ALIAS,
})
const NO_HOOK_REEXPORT = [
  hookBan("ExportAllDeclaration[source.value='react']"),
  hookBan("ExportNamedDeclaration[source.value='react'] > ExportSpecifier[local.name='default']"),
  hookBan(`ExportSpecifier[local.name=${HANDED_ON}]`),
  hookBan(`ExportDefaultDeclaration > Identifier.declaration[name=${HANDED_ON}]`),
  hookBan(`VariableDeclarator > Identifier.init[name=${HANDED_ON}]`),
  hookBan(`VariableDeclarator > MemberExpression.init[property.name=${HOOKS}]`),
  hookBan(`VariableDeclarator[init.type='Identifier'] > ObjectPattern.id > Property[key.name=${HOOKS}]`),
]
// Style the wallet guidelines do not ask for.
const STYLE_OFF = Object.fromEntries(
  ["no-useless-escape", "no-var", "prefer-const", "prefer-rest-params", "prefer-spread"].map((rule) => [
    rule,
    "off",
  ]),
)
// The hook ban and the debt rules cover a package's whole source, migrated or not.
const SOURCE = ["src/**/*.{ts,tsx,js,mjs}"]

// Debt the slices remove (preamble "Lint and format"). Each existing case carries
// `// eslint-disable-next-line <rule> -- ZKM-<n>` naming the issue that removes it.
const SINGLETON = "Take this page-wide value from the Page or Session you were given, not from its module (ZKM-1778)."
// A module by its file name, through any relative path.
const relative = (name) => `^\\.\\.?/(?:.*/)?${name}(?:\\.[jt]sx?)?$`
const frontCore = (dir, name) =>
  `^@obsidion/front-core(?:/.*)?$|${relative(name)}|^\\.\\.?/(?:.*/)?${dir}(?:/index)?(?:\\.[jt]sx?)?$`
const PAGE_READS = {
  [relative("env")]: ["getConfig", "getContractServiceOptions", "fetchLiveProfilePortal"],
  [frontCore("contexts", "useContractServiceContext")]: ["useContractServiceContext"],
  [relative("rollupStorage")]: ["activeRollup"],
  [relative("wallet")]: ["pageWallet"],
  [relative("activeTabSince")]: ["activeTabSince"],
  [frontCore("core", "activeGenerationNode")]: ["getActiveGenerationNode"],
  [frontCore("core", "nodeApiKey")]: ["getNodeApiKey"],
  // The memoized chain reads and the page-wide reads over them.
  [relative("oxideTuple")]: [
    "getOxideTuple",
    "getOxideDeployment",
    "getFeeTokenBridgeTuple",
    "getDeploymentTable",
    "getSipaDeploymentTable",
    "getRetiredRollupSources",
    "getOtherManifestSources",
    "getManifestBridges",
    "getManifestDeployments",
    "getPortalTuple",
    "oxideEnvFor",
  ],
  [relative("savingsGateway")]: [
    "getSkySavings",
    "getSavingsTuple",
    "prefetchLiveSavingsApy",
    "useLiveSavingsApy",
    "useSavingsAvailable",
  ],
  [relative("oxideToken")]: ["currentTxAmountCap"],
}
// The page's static instance, through any import of the class.
const PAGE_STATICS = { "^@obsidion/(sdk|contracts)(?:/.*)?$": { ContractService: "getInstance" } }
// A view reads a service's status, never its value: the flow it starts awaits the value.
const HELD_SERVICE = "Read the service's status with serviceStatus, and let the flow await its value with ready()."
const RESOURCE_HOOK = /^@obsidion\/front-core(\/.*)?$|\/useResource(\.[jt]sx?)?$/
const EFFECT = "Move this effect's work into a screen flow, a runtime task or a store (ZKM-1720)."
const EFFECT_HOOKS = ["useEffect", "useLayoutEffect", "useInsertionEffect"]
const DOM_EFFECTS = "^(useDomEffect|useDomLayoutEffect)$"
const MODULE = "Keep this state in a store that the Page or the Session builds, not at module level."
const TOP = ["Program", "Program > ExportNamedDeclaration"]
const DEFAULT = "Program > ExportDefaultDeclaration"
// A collection, a store, or an instance of a class that holds state: not a value builtin.
const VALUE_CLASSES = "/^(TextEncoder|TextDecoder|URL|RegExp|Date|Error|\\w+Array|ArrayBuffer|DataView)$/"
const HELD = [
  `NewExpression[callee.type='Identifier'][callee.name=/^[A-Z]/]:not([callee.name=${VALUE_CLASSES}])`,
  "CallExpression[callee.name=/^(memoryStore|persistentStore)$/]",
]
// A const typed read-only, or a `memoryStore(…).readonly` sentinel, is not state.
const STATE_CONST =
  "VariableDeclarator:not([id.typeAnnotation.typeAnnotation.typeName.name=/^(ReadonlySet|ReadonlyMap|Readonly)$/])" +
  ":not([init.type='MemberExpression'][init.property.name='readonly'])"
const moduleState = (selector) => ({ selector, message: MODULE })
const DEBT_SYNTAX = [
  ...TOP.map((top) => moduleState(`${top} > VariableDeclaration[kind=/^(let|var)$/][declare!=true]`)),
  // Held anywhere in the initializer but inside a function.
  ...TOP.flatMap((top) =>
    HELD.map((held) =>
      moduleState(`${top} > VariableDeclaration[kind='const'] > ${STATE_CONST} ${held}:not(:function ${held})`),
    ),
  ),
  ...TOP.map((top) =>
    moduleState(`${top} > VariableDeclaration[kind='const'] > ${STATE_CONST} > MemberExpression.init[property.name='instance']`),
  ),
  ...HELD.map((held) => moduleState(`${DEFAULT} > ${held}`)),
  moduleState("PropertyDefinition[static=true][readonly!=true]"),
  moduleState("PropertyDefinition[static=true][key.name=/^instances?$/]"),
  ...HELD.map((held) => moduleState(`PropertyDefinition[static=true] > ${held}.value`)),
  // `globalThis.x`, `globalThis.a.b` or `(globalThis as T).x`.
  moduleState("AssignmentExpression > MemberExpression.left:has(Identifier[name='globalThis'])"),
  {
    selector: `ImportExpression[source.value=/\\/(${["env", "oxideTuple", "savingsGateway", "rollupStorage", "wallet", "activeTabSince", "oxideToken"].join("|")})(\\.[jt]sx?)?$/]`,
    message: SINGLETON,
  },
]

// The tagged disables cover every package file; the session rule skips the test directories.
const PACKAGE = ["**/*.{ts,tsx,js,mjs}"]
const TESTS = ["test/**", "e2e/**"]
// Build and test output a package may hold untracked.
const OUTPUT = [
  ...["dist", "dest", ".vercel", "coverage", "storybook-static"],
  ...["test-results", "playwright-report", "test-artifacts"],
].map((dir) => `${dir}/**`)
const CURRENT = "Pass in the session this code runs in, instead of reading the current one with session() or openedSession.get()."
const STORE = "Move the records kept in {{channel}} into a persistent store on the Database."
const HEADER = 'Start the file with "/** Storage migration: <what it carries>. Remove when <condition>. */".'
const MIGRATIONS = ["src/**/storageMigrations/**/*.{ts,tsx,js,mjs}"]
const TIMER = "Move this timer or poll into a runtime task, or read the Page clock instead."
const MESSAGE = "Keep the error's code and render its copy, instead of showing err.message."
const WALL_CLOCK =
  'Take the time from the `now` in deps or an argument, not Date.now (docs/conventions/wallet-architecture.md, "The engine").'
// A view is a component file or a file named for a hook.
const isView = (file) => /\.tsx$/.test(file) || /(^|[\\/])use[A-Z]\w*\.ts$/.test(file)
const isHookName = (id) => id?.type === "Identifier" && /^use[A-Z]/.test(id.name)
// Presentational code: any file under a `ui/` folder, or in a component's folder but its screen
// flow and Transition.
const isPresentational = (context) => {
  const file = path.relative(context.cwd, context.filename)
  if (/(^|[\\/])ui[\\/]/.test(file)) return true
  return /(^|[\\/])[A-Z]\w*[\\/][^\\/]+$/.test(file) && !/(Flow|Transition)\.ts$/.test(file)
}
const TIMERS = /^(setInterval|setTimeout)$/
const POLLS = /^(every|after|wait)$/
// Names a binding or field takes when it holds an error.
const ERROR_NAME = /^(e|err|error|cause|exception)$/
const ERROR_FIELD = /^(err|error|cause|exception)$/
const unwrap = (node) =>
  /^(ChainExpression|TSNonNullExpression|TSAsExpression|TSTypeAssertion)$/.test(node.type) ? unwrap(node.expression) : node
// `x instanceof Error ? x.message : …`, `x instanceof Error && x.message` and `if (x instanceof Error)`.
function narrowedToError(node, name) {
  for (let child = node, at = node.parent; at; child = at, at = at.parent) {
    const test = at.type === "LogicalExpression" ? at.left : at.test
    const guards = at.type === "LogicalExpression" ? at.operator === "&&" && at.right === child : at.consequent === child
    if (!guards || !/^(ConditionalExpression|IfStatement|LogicalExpression)$/.test(at.type)) continue
    if (test?.type === "BinaryExpression" && test.operator === "instanceof" && test.left.type === "Identifier" && test.left.name === name)
      return true
  }
  return false
}
// A catch clause's binding, or a parameter of a `.catch(…)` or `.then(_, …)` handler.
function boundToError(context, id) {
  let variable
  for (let scope = context.sourceCode.getScope(id); scope && !variable; scope = scope.upper)
    variable = scope.references.find((r) => r.identifier === id)?.resolved
  return (variable?.defs ?? []).some((def) => {
    if (def.type === "CatchClause") return true
    if (def.type !== "Parameter") return false
    const call = def.node.parent
    if (call?.type !== "CallExpression" || call.callee.type !== "MemberExpression") return false
    const handler = { catch: 0, then: 1 }[memberKey(call.callee)]
    return handler !== undefined && call.arguments[handler] === def.node
  })
}
// Whether `member.message` reads an error: see ERROR_NAME, boundToError and narrowedToError.
function readsError(context, member) {
  const raw = member.object
  if (raw.type === "TSAsExpression" && /Error$/.test(raw.typeAnnotation.typeName?.name ?? "")) return true
  const object = unwrap(raw)
  if (object.type === "NewExpression") return /Error$/.test(object.callee.name ?? "")
  if (object.type === "MemberExpression") return ERROR_FIELD.test(memberKey(object) ?? "")
  if (object.type !== "Identifier") return false
  return ERROR_NAME.test(object.name) || boundToError(context, object) || narrowedToError(member, object.name)
}
// The session module, from anywhere or from its own directory.
const SESSION_MODULE = /(^|\/)session\/session$|^\.\/session$/
const importOf = (node) => {
  const expr = node?.type === "AwaitExpression" ? node.argument : node
  return expr?.type === "ImportExpression" && SESSION_MODULE.test(expr.source.value ?? "")
}
const calledAt = (node) => node.parent.type === "CallExpression" && node.parent.callee === node
// `x.get()` on the node.
const gotAt = (node) =>
  node.parent.type === "MemberExpression" &&
  node.parent.object === node &&
  memberKey(node.parent) === "get" &&
  calledAt(node.parent)

const memberKey = (member) => member.property.name ?? member.property.value
/**
 * The nodes `pick` returns for each use of react's default or namespace binding ("react") or an
 * effect hook's binding ("hook"). It follows `const alias = binding` and `const alias = R.useEffect`,
 * and passes each such alias to `pick` as well.
 */
function reactBindings(context, node, pick) {
  if (node.source.value !== "react" || node.importKind === "type") return []
  const found = []
  const visit = (variable, kind) => {
    for (const { identifier: id } of variable.references.filter((ref) => ref.isRead())) {
      // A type position, or the JSX pragma's implicit read of the import itself.
      if (/^(TSTypeQuery|TSQualifiedName|Import\w*Specifier)$/.test(id.parent.type)) continue
      const member = id.parent.type === "MemberExpression" && id.parent.object === id && id.parent
      const held = member && EFFECT_HOOKS.includes(memberKey(member)) ? member : id
      const alias = held.parent.type === "VariableDeclarator" && held.parent.init === held && held.parent.id
      if (alias?.type === "Identifier") {
        const hit = pick(kind, held, true)
        if (hit) found.push(hit)
        for (const next of context.sourceCode.getDeclaredVariables(held.parent))
          visit(next, held === member ? "hook" : kind)
        continue
      }
      const hit = pick(kind, id)
      if (hit) found.push(hit)
    }
  }
  for (const spec of node.specifiers) {
    // `import { default as R }` binds the module, like a default or namespace import.
    const key = spec.imported?.name ?? spec.imported?.value
    const named = spec.type === "ImportSpecifier" && key !== "default"
    if (spec.importKind === "type" || (named && !EFFECT_HOOKS.includes(key))) continue
    for (const variable of context.sourceCode.getDeclaredVariables(spec)) visit(variable, named ? "hook" : "react")
  }
  return found
}
const RANGE = "Disable one line at a time, with eslint-disable-next-line."
const UNTAGGED = "End the disable with `-- ZKM-<n>`, the issue that removes it."
const RULELESS = "List the rules this disable turns off."
const INLINE = "Configure rules in eslint.config.mjs, not in a comment."
// Each comment that disables or configures rules and breaks the rules above.
function disableProblems(text, filename) {
  let comments
  try {
    comments = tseslint.parser.parseForESLint(text, { jsx: /x$/.test(filename), comment: true, loc: true }).ast.comments
  } catch {
    // ESLint reports the parse error itself.
    return []
  }
  const problems = []
  for (const comment of comments) {
    const [head, reason = ""] = comment.value.trim().split(/\s--+\s/, 2)
    const report = (messageId, message) => problems.push({ loc: comment.loc, messageId, message })
    // No comment reconfigures a rule, quoted or not.
    if (/^eslint\s/.test(head)) report("inline", INLINE)
    const disable = /^eslint-disable(-next-line|-line)?(?:\s+(\S.*))?$/s.exec(head)
    if (!disable) continue
    if (!disable[1]) report("range", RANGE)
    else if (!disable[2]) report("ruleless", RULELESS)
    else if (!/^ZKM-\d+\b/.test(reason.trim())) report("untagged", UNTAGGED)
  }
  return problems
}
// A disable can hide a report on its own line or the next, a wide one every report after it, and an
// inline config can turn a rule off. So this processor checks the comments itself, after ESLint
// applies them, and reports as `local/tagged-disable`.
const sources = new Map()
const disableChecks = {
  meta: { name: "disable-checks" },
  supportsAutofix: true,
  preprocess(text, filename) {
    sources.set(filename, text)
    return [text]
  },
  postprocess([messages], filename) {
    const found = disableProblems(sources.get(filename) ?? "", filename).map(({ loc: { start }, messageId, message }) => ({
      ruleId: "local/tagged-disable",
      messageId,
      severity: 2,
      message,
      line: start.line,
      column: start.column + 1,
    }))
    sources.delete(filename)
    return [...messages, ...found]
  },
}
// The processor reports for this rule, so a disable that names it suppresses nothing.
const local = {
  rules: {
    "tagged-disable": { meta: { type: "problem", schema: [] }, create: () => ({}) },
    // A rejection handler that only yields a value and never reads its error.
    "no-swallow": {
      meta: { type: "problem", schema: [], messages: { swallowed: SWALLOWED } },
      create: (context) => {
        const isValue = (n) =>
          n && (VALUE.test(n.type) || (n.type === "UnaryExpression" && n.argument.type === "Literal"))
        const yieldsValue = ({ body }) =>
          body.type === "BlockStatement"
            ? body.body.length === 1 && body.body[0].type === "ReturnStatement" && isValue(body.body[0].argument)
            : isValue(body)
        const check = (fn) => {
          if (!/^(ArrowFunctionExpression|FunctionExpression)$/.test(fn?.type ?? "") || !yieldsValue(fn)) return
          const reads = context.sourceCode
            .getDeclaredVariables(fn)
            .some((v) => v.defs.some((d) => d.type === "Parameter") && v.references.length > 0)
          if (!reads) context.report({ node: fn, messageId: "swallowed" })
        }
        return {
          CallExpression(node) {
            const name = node.callee.type === "MemberExpression" ? node.callee.property.name : undefined
            if (name === "catch") check(node.arguments[0])
            else if (name === "then") check(node.arguments[1])
          },
        }
      },
    },
    // Each call of `useResource`, through any import of the hook.
    "held-service": {
      meta: { type: "problem", schema: [], messages: { held: HELD_SERVICE } },
      create: (context) => ({
        ImportDeclaration(node) {
          if (node.importKind === "type" || !RESOURCE_HOOK.test(node.source.value)) return
          for (const spec of node.specifiers) {
            const whole = spec.type === "ImportNamespaceSpecifier"
            if (spec.importKind === "type" || (!whole && spec.imported?.name !== "useResource")) continue
            const refs = context.sourceCode.getDeclaredVariables(spec).flatMap((v) => v.references)
            for (const { identifier: id } of refs) {
              const hook = whole
                ? id.parent.type === "MemberExpression" && memberKey(id.parent) === "useResource" && id.parent
                : id
              if (!hook) continue
              // An alias of the hook would hide its calls.
              const called = hook.parent.type === "CallExpression" && hook.parent.callee === hook
              context.report({ node: called ? hook.parent : hook, messageId: "held" })
            }
          }
        },
      }),
    },
    // Each read of a page-wide accessor, through any import of its module.
    "page-singleton": {
      meta: { type: "problem", schema: [], messages: { read: SINGLETON } },
      create: (context) => ({
        ImportDeclaration(node) {
          if (node.importKind === "type") return
          const statics = Object.entries(PAGE_STATICS)
            .filter(([regex]) => new RegExp(regex).test(node.source.value))
            .flatMap(([, table]) => Object.entries(table))
          for (const spec of statics.length > 0 ? node.specifiers : []) {
            if (spec.importKind === "type") continue
            const whole = spec.type === "ImportNamespaceSpecifier"
            for (const { references } of context.sourceCode.getDeclaredVariables(spec))
              for (const { identifier: id } of references)
                for (const [name, method] of statics) {
                  // The class itself: the named binding, or `ns.Class`.
                  const cls = whole
                    ? id.parent.type === "MemberExpression" && memberKey(id.parent) === name && id.parent
                    : spec.imported?.name === name && id
                  const read = cls && cls.parent.type === "MemberExpression" && cls.parent.object === cls && cls.parent
                  if (read && memberKey(read) === method) context.report({ node: read, messageId: "read" })
                }
          }
          const names = Object.entries(PAGE_READS)
            .filter(([regex]) => new RegExp(regex).test(node.source.value))
            .flatMap(([, list]) => list)
          for (const spec of names.length > 0 ? node.specifiers : []) {
            const whole = spec.type === "ImportNamespaceSpecifier"
            if (spec.importKind === "type" || (!whole && !names.includes(spec.imported?.name))) continue
            for (const { references } of context.sourceCode.getDeclaredVariables(spec))
              for (const { identifier: id } of references) {
                let type = id.parent
                while (type.type === "TSQualifiedName") type = type.parent
                if (type.type === "TSTypeQuery") continue
                const member = id.parent.type === "MemberExpression" && id.parent.object === id
                const key = member && (id.parent.property.name ?? id.parent.property.value)
                if (!whole || !member) context.report({ node: id, messageId: "read" })
                else if (names.includes(key)) context.report({ node: id.parent, messageId: "read" })
              }
          }
        },
      }),
    },
    // Each use of React's effect hooks, through any import of react.
    // Each use of React's effect hooks, through any import of react and any local alias of it.
    "effect-hook": {
      meta: { type: "problem", schema: [], messages: { effect: EFFECT } },
      create: (context) => ({
        ImportDeclaration(node) {
          reactBindings(context, node, (kind, id, alias) => {
            if (alias) return undefined
            if (kind === "hook") return id
            const member = id.parent.type === "MemberExpression" && id.parent.object === id && id.parent
            if (!member) return undefined
            if (!EFFECT_HOOKS.includes(memberKey(member))) return undefined
            return member
          }).forEach((node) => context.report({ node, messageId: "effect" }))
        },
      }),
    },
    // React itself, or a hook, handed on under another binding: a re-export, an argument, a field.
    "hook-alias": {
      meta: { type: "problem", schema: [], messages: { alias: HOOK_ALIAS } },
      create: (context) => ({
        ImportDeclaration(node) {
          reactBindings(context, node, (kind, id, alias) => {
            if (alias) return id
            if (kind === "hook") return id.parent.type === "CallExpression" && id.parent.callee === id ? undefined : id
            const member = id.parent.type === "MemberExpression" && id.parent.object === id
            return member || id.parent.type === "JSXMemberExpression" ? undefined : id
          }).forEach((node) => context.report({ node, messageId: "alias" }))
        },
      }),
    },
    // Each legacy channel a wallet source file persists state through, at its first use.
    "legacy-store": {
      meta: { type: "problem", schema: [], messages: { store: STORE } },
      create: (context) => ({
        Program() {
          const file = repoPath(context.filename)
          for (const { channel, at } of file ? storeSites(file, context.sourceCode.text) : [])
            context.report({ loc: context.sourceCode.getLocFromIndex(at), messageId: "store", data: { channel } })
        },
      }),
    },
    // A storage migration's first comment, before any code, names it and states when it goes.
    // Each read of an error's `message` in a view, but the one a `return` hands back.
    "message-in-state": {
      meta: { type: "problem", schema: [], messages: { message: MESSAGE } },
      create: (context) =>
        !isView(context.filename)
          ? {}
          : {
              MemberExpression(node) {
                if (memberKey(node) !== "message" || (node.computed && node.property.type !== "Literal")) return
                const { parent } = node
                if (parent.type === "AssignmentExpression" && parent.left === node) return
                if (parent.type === "ReturnStatement") return
                if (parent.type === "MemberExpression" && parent.object === node) return
                if (readsError(context, node)) context.report({ node, messageId: "message" })
              },
            },
    },    // Each timer or pace poll a view, a hook's file or presentational code starts.
    "timer-in-view": {
      meta: { type: "problem", schema: [], messages: { timer: TIMER } },
      create: (context) => {
        let hook = false
        const calls = []
        const key = (node) => (node.type === "MemberExpression" ? memberKey(node) : node.name)
        return {
          FunctionDeclaration: (node) => (hook ||= isHookName(node.id)),
          VariableDeclarator: (node) => (hook ||= isHookName(node.id)),
          CallExpression(node) {
            const callee = node.callee
            if (TIMERS.test(key(callee) ?? "")) calls.push(node)
            else if (callee.type === "MemberExpression" && POLLS.test(memberKey(callee) ?? "")) {
              if (key(callee.object) === "pace") calls.push(node)
            }
          },
          "Program:exit"() {
            if (!isView(context.filename) && !hook && !isPresentational(context)) return
            for (const node of calls) context.report({ node, messageId: "timer" })
          },
        }
      },
    },
    // Each read of `Date.now`: a call, a default or a fallback.
    "wall-clock": {
      meta: { type: "problem", schema: [], messages: { clock: WALL_CLOCK } },
      create: (context) => ({
        "MemberExpression[object.name='Date'][property.name='now']": (node) =>
          context.report({ node, messageId: "clock" }),
      }),
    },
    "storage-migration-header": {
      meta: { type: "problem", schema: [], messages: { header: HEADER } },
      create: (context) => ({
        Program(node) {
          const [first] = context.sourceCode.getAllComments()
          const opens = first?.type === "Block" && !context.sourceCode.text.slice(0, first.range[0]).trim()
          const text = opens ? first.value : ""
          if (!/Storage\s+(?:\*\s*)?migration:/.test(text) || !/Remove\s+(?:\*\s*)?when/.test(text))
            context.report({ node, loc: { line: 1, column: 0 }, messageId: "header" })
        },
      }),
    },
    // Each read of the current session outside React: a call of the module's `session()`, or
    // `openedSession.get()`, through a named, aliased, namespace or dynamic import.
    "session-accessor": {
      meta: { type: "problem", schema: [], messages: { current: CURRENT } },
      create: (context) => {
        if (/export const openedSession\b/.test(context.sourceCode.text)) return {}
        const report = (node) => context.report({ node, messageId: "current" })
        // A read through the whole module: `ns.session()` or `ns.openedSession.get()`.
        const fromModule = (node) => {
          const member = node.parent.type === "MemberExpression" && node.parent.object === node && node.parent
          if (!member) return
          if (memberKey(member) === "session" && calledAt(member)) report(member.parent)
          if (memberKey(member) === "openedSession" && gotAt(member)) report(member.parent.parent)
        }
        const bound = (variable, name) => {
          for (const { identifier: id } of variable.references) {
            if (name === "module") fromModule(id)
            else if (name === "session" && calledAt(id)) report(id.parent)
            else if (name === "openedSession" && gotAt(id)) report(id.parent.parent)
          }
        }
        return {
          ImportDeclaration(node) {
            if (node.importKind === "type" || !SESSION_MODULE.test(node.source.value)) return
            for (const spec of node.specifiers) {
              if (spec.importKind === "type") continue
              const name = spec.type === "ImportSpecifier" ? (spec.imported.name ?? spec.imported.value) : "module"
              for (const variable of context.sourceCode.getDeclaredVariables(spec)) bound(variable, name)
            }
          },
          VariableDeclarator(node) {
            if (!importOf(node.init)) return
            if (node.id.type === "Identifier")
              for (const variable of context.sourceCode.getDeclaredVariables(node)) bound(variable, "module")
            if (node.id.type !== "ObjectPattern") return
            const declared = context.sourceCode.getDeclaredVariables(node)
            for (const prop of node.id.properties) {
              if (prop.type !== "Property" || prop.value.type !== "Identifier") continue
              const variable = declared.find((v) => v.name === prop.value.name)
              if (variable) bound(variable, prop.key.name ?? prop.key.value)
            }
          },
          // `m = await import(…)` or `({ session: o } = await import(…))`.
          AssignmentExpression(node) {
            if (!importOf(node.right)) return
            const scope = context.sourceCode.getScope(node)
            const resolve = (id) => {
              for (let s = scope; s; s = s.upper) {
                const ref = s.references.find((r) => r.identifier === id)
                if (ref) return ref.resolved
              }
              return undefined
            }
            if (node.left.type === "Identifier") {
              const variable = resolve(node.left)
              if (variable) bound(variable, "module")
            }
            if (node.left.type !== "ObjectPattern") return
            for (const prop of node.left.properties) {
              if (prop.type !== "Property" || prop.value.type !== "Identifier") continue
              const variable = resolve(prop.value)
              if (variable) bound(variable, prop.key.name ?? prop.key.value)
            }
          },
          // `(await import("…/session/session")).session()`.
          AwaitExpression(node) {
            if (importOf(node)) fromModule(node)
          },
        }
      },
    },
  },
}
const jsxCopy = (selector) => ({
  selector,
  message: "Move this text into the component's Foo.copy.ts and render it from there.",
})
const WORDS = ["Literal[value=/[A-Za-z]/]", "TemplateLiteral:has(TemplateElement[value.raw=/[A-Za-z]/])"]
// Words in a child or copy attribute's `{…}`, directly or as a branch of `?:`, `&&`, `||` or `??`.
const NO_JSX_COPY = [
  jsxCopy("JSXText[value=/[A-Za-z]/]"),
  jsxCopy(`${COPY_ATTR} > ${WORDS[0]}`),
  ...[":matches(JSXElement, JSXFragment) > JSXExpressionContainer", `${COPY_ATTR} > JSXExpressionContainer`]
    .flatMap((slot) => ["", " > ConditionalExpression", " > LogicalExpression"].map((via) => `${slot}${via}`))
    .flatMap((slot) => WORDS.map((words) => jsxCopy(`${slot} > ${words}`))),
]

/**
 * @param {object} migrated
 * @param {string} migrated.tsconfigRootDir the package directory (`import.meta.dirname`)
 * @param {string[]} [migrated.engine] framework-free code: no React, no event emitters, no floating promises
 * @param {string[]} [migrated.react] hooks and components
 * @param {string[]} [migrated.views] components in folders: also no copy literals in JSX
 * @param {string[]} [migrated.tests] tests: no module mocks
 * @param {boolean} [migrated.copyFreeTests] tests also never assert copy
 * @param {string[]} [migrated.platformStorage] the platform storage code, which may touch storage directly
 * @param {string[]} [migrated.storageBaseline] migrated files that still touch storage directly; may only shrink
 * @param {string[]} [migrated.browserStorage] dev code, which may touch browser storage but not walletStorage
 * @param {boolean} [migrated.debt] the debt rules cover all of `src/`, and the tagged disables every package file
 * @param {string[]} [migrated.domEffects] the useDomEffect wrappers, which may import React's effect hooks
 * @param {string[]} [migrated.effectPrimitives] primitives and dev code that may run React's effect hooks
 * @param {string[]} [migrated.pageTime] code that takes the time as an input: no Date.now
 */
export function migrated({
  tsconfigRootDir,
  engine = [],
  react = [],
  views = [],
  tests = [],
  copyFreeTests = false,
  platformStorage = [],
  storageBaseline = [],
  browserStorage = [],
  debt = false,
  domEffects = [],
  effectPrimitives = [],
  pageTime = [],
}) {
  const all = [...engine, ...react, ...views, ...tests]
  const debtSyntax = debt ? DEBT_SYNTAX : []
  const storageExempt = [...platformStorage, ...storageBaseline]
  // The rule for `files`, with the storage bans added for each file that is not storage-exempt.
  const exempting = (files, rule, options) =>
    files.length === 0
      ? []
      : [
          { files, rules: { [rule]: options(false) } },
          { files, ignores: storageExempt, rules: { [rule]: options(true) } },
        ]
  // engine, react and views are source files, so their rules carry the debt rules too.
  const syntax = (selectors) => (storage) => [
    "error",
    ...selectors,
    ...NO_HOOK_REEXPORT,
    ...debtSyntax,
    ...(storage ? [NO_STORAGE_IMPORT] : []),
  ]
  const imports = (...patterns) => ["error", { patterns }]
  return tseslint.config(
    { ignores: OUTPUT },
    {
      files: SOURCE,
      languageOptions: { parser: tseslint.parser },
      // Registered so the disable comments in files outside `all` resolve.
      plugins: { "@typescript-eslint": tseslint.plugin, "react-hooks": reactHooks, local },
      rules: {
        "local/hook-alias": "error",
        "no-restricted-syntax": ["error", ...NO_HOOK_REEXPORT, ...debtSyntax],
        "no-restricted-imports": imports(),
      },
    },
    debt
      ? {
          files: [...PACKAGE, ...all],
          languageOptions: { parser: tseslint.parser },
          plugins: { "@typescript-eslint": tseslint.plugin, "react-hooks": reactHooks, local },
          processor: disableChecks,
          linterOptions: { reportUnusedDisableDirectives: "error" },
          rules: { "local/tagged-disable": "error" },
        }
      : { files: SOURCE, ignores: all, linterOptions: { reportUnusedDisableDirectives: "off" } },
    debt && {
      files: SOURCE,
      rules: { "local/page-singleton": "error", "local/effect-hook": "error", "local/held-service": "error" },
    },
    // Browser storage stays in platform storage, storage migrations and dev code.
    debt && {
      files: SOURCE,
      ignores: [...storageExempt, ...browserStorage, ...MIGRATIONS],
      rules: STORAGE_RULES,
    },
    debt && { files: MIGRATIONS, rules: { "local/storage-migration-header": "error" } },
    debt && { files: SOURCE, rules: { "local/legacy-store": "error" } },
    debt && {
      files: ["**/*.{ts,tsx}"],
      ignores: TESTS,
      rules: { "local/session-accessor": "error" },
    },
    // The view rules skip tests wherever they live.
    debt && {
      files: ["**/*.{ts,tsx}"],
      ignores: [...TESTS, "**/*.{test,spec}.{ts,tsx}"],
      rules: { "local/timer-in-view": "error", "local/message-in-state": "error" },
    },
    debt &&
      domEffects.length + effectPrimitives.length > 0 && {
        files: [...domEffects, ...effectPrimitives],
        rules: { "local/effect-hook": "off" },
      },
    {
      files: all,
      extends: [js.configs.recommended, ...tseslint.configs.recommended],
      plugins: { prettier, local },
      rules: {
        "prettier/prettier": "error",
        "local/no-swallow": "error",
        "no-empty": ["error", { allowEmptyCatch: false }],
        "no-restricted-syntax": ["error", ...NO_SWALLOW, ...NO_HOOK_REEXPORT],
        // tsc's noUnused* checks miss tests outside a tsconfig; a rest sibling names what it drops.
        "@typescript-eslint/no-unused-vars": [
          "error",
          { argsIgnorePattern: "^_", ignoreRestSiblings: true },
        ],
        // An empty interface is an augmentation target; `{}` as a type stays banned.
        "@typescript-eslint/no-empty-object-type": ["error", { allowInterfaces: "always" }],
        ...STYLE_OFF,
        // `import { type A }` keeps a side-effect import under verbatimModuleSyntax.
        "@typescript-eslint/no-import-type-side-effects": "error",
      },
    },
    engine.length > 0 && {
      files: engine,
      languageOptions: { parserOptions: { projectService: true, tsconfigRootDir } },
      rules: { "@typescript-eslint/no-floating-promises": "error" },
    },
    ...exempting(engine, "no-restricted-syntax", syntax([...NO_SWALLOW, ...NO_THROW])),
    ...exempting(engine, "no-restricted-imports", (storage) =>
      imports(
        { group: ["react", "react-dom", "react/*"], message: "Keep React out of engine code, and move this into a hook or a view." },
        { group: ["eventemitter3", "**/GlobalEventEmitter"], message: "Replace the event emitter with a store that readers subscribe to." },
        ...(storage ? [STORAGE_IMPORTS] : []),
      ),
    ),
    engine.length + react.length + views.length > 0 && {
      files: [...engine, ...react, ...views],
      ignores: [...storageExempt, ...browserStorage],
      rules: STORAGE_RULES,
    },
    react.length + views.length > 0 && {
      files: [...react, ...views],
      ignores: [...storageExempt, ...engine],
      rules: { "no-restricted-imports": imports(STORAGE_IMPORTS) },
    },
    react.length + views.length > 0 && {
      files: [...react, ...views],
      plugins: { "react-hooks": reactHooks },
      rules: {
        ...reactHooks.configs.recommended.rules,
        "react-hooks/exhaustive-deps": ["warn", { additionalHooks: DOM_EFFECTS }],
      },
    },
    ...exempting([...react, ...views], "no-restricted-syntax", syntax([...NO_SWALLOW, ...NO_THROW])),
    ...exempting(views, "no-restricted-syntax", syntax([...NO_SWALLOW, ...NO_THROW, ...NO_JSX_COPY])),
    tests.length > 0 && {
      files: tests,
      rules: {
        // A test patches a fake onto a real object; production code keeps its types.
        "@typescript-eslint/no-explicit-any": "off",
        "no-restricted-syntax": [
          "error",
          ...NO_SWALLOW,
          NO_MODULE_MOCKS,
          ...NO_HOOK_REEXPORT,
          ...(copyFreeTests ? NO_COPY : []),
        ],
      },
    },
    pageTime.length > 0 && { files: pageTime, plugins: { local }, rules: { "local/wall-clock": "error" } },
    // The wrappers call React's effect hooks with their callers' deps, which the callers check.
    domEffects.length > 0 && {
      files: domEffects,
      rules: {
        "no-restricted-imports": ["error", { patterns: [STORAGE_IMPORTS] }],
        "react-hooks/exhaustive-deps": "off",
      },
    },
  ).filter(Boolean)
}
