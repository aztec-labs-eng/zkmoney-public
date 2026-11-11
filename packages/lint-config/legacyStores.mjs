// The legacy store scan: a legacy store is a source file that owns persisted state through a legacy
// channel. Lint reports each channel (`local/legacy-store`), and `scripts/store-map.mjs` counts them.

const PACKAGES = ["front-core", "web-wallet", "passkey-web"]
const isTest = (f) => /\/(test|e2e)\/|\.(test|spec)\.tsx?$/.test(f)
const isStorageMigration = (f) => f.includes("/storageMigrations/")

/** A non-test source file under a wallet package's `src/`. */
export const isWalletSource = (f) =>
  PACKAGES.some((p) => f.startsWith(`packages/${p}/src/`)) &&
  /\.(ts|tsx|js|mjs)$/.test(f) &&
  !f.endsWith(".d.ts") &&
  !isTest(f)

const CHANNEL_IMPLEMENTATIONS = [
  "packages/web-wallet/src/platform/storage/",
  "packages/front-core/src/core/storages/adapter.ts",
  "packages/front-core/src/core/services/bridge/RecordStorage.ts",
]

// The keys each channel may hold, and the key type that allows any key it types. A trailing `*` is
// a prefix. DEVICE mirrors `DeviceStorageKey` in packages/web-wallet/src/platform/storage/
// rollupStorage.ts, and TAB mirrors `TabKey` in packages/web-wallet/src/platform/storage/tabStash.ts.
const DEVICE = {
  keys: ["webwallet.endpoints", "zkm_bid", "webwallet.attribution", "webwallet.inbound-invite"],
  type: "DeviceStorageKey",
}
const TAB = {
  keys: [
    "obsidion.pending-claim",
    "obsidion.pending-claim.ticket",
    "obsidion.pending-connect",
    "obsidion.name-grant*",
    "obsidion.drawn-offer",
    "obsidion.tag-*",
    "zkm.pastUserVerified",
    "zkm.pastUserCheck.*",
    "obsidion.link-read:*",
    "zkm.once.*",
    "pxeBoot.downloadReloads",
    "webwallet.demo",
    "webwallet.preview-config-draft",
  ],
  type: "TabKey",
}
const ALLOWED_KEYS = {
  deviceStorage: DEVICE,
  localStorage: DEVICE,
  rollupStorage: DEVICE,
  tabStash: TAB,
  sessionStorage: TAB,
}
const KEY_TYPES = [DEVICE.type, TAB.type]
// A parameter type that allows any key it types; a union, array or generic does not.
const KEY_TYPE = new RegExp(`^(${KEY_TYPES.join("|")})\\b(?!\\s*[[<|.])`)

const UNKNOWN = "*"

/** Whether `channel` may hold a resolved key (`*` marks an unresolved part). */
const isAllowedKey = (channel, key) => {
  const { keys, type } = ALLOWED_KEYS[channel]
  if (key.startsWith("<")) return key === `<${type}>`
  const known = key.split(UNKNOWN)[0]
  return keys.some((allowed) =>
    allowed.endsWith(UNKNOWN) ? known.startsWith(allowed.slice(0, -1)) : key === allowed,
  )
}

const blank = (chars, from, to) => {
  for (let i = from; i < to; i++) if (chars[i] !== "\n") chars[i] = " "
}
const REGEX_AFTER = new Set(["return", "typeof", "case", "do", "else", "in", "of", "void", "throw"])

/**
 * Source with comments blanked (`code`), and also with string, template and regex text blanked
 * (`bare`). Offsets agree across both and the source.
 */
function lex(text) {
  const n = text.length
  const code = text.split("")
  const bare = text.split("")
  const templates = []
  let depth = 0
  let i = 0
  const templateText = () => {
    const start = i
    while (i < n && text[i] !== "`" && !(text[i] === "$" && text[i + 1] === "{"))
      i += text[i] === "\\" ? 2 : 1
    blank(bare, start, Math.min(i, n))
    if (text[i] === "`") i++
    else if (i < n) {
      templates.push(depth++)
      i += 2
    }
  }
  const regexAllowed = () => {
    let k = i - 1
    while (k >= 0 && /\s/.test(code[k])) k--
    if (k < 0) return true
    if (/[\w$]/.test(code[k])) {
      let w = k
      while (w > 0 && /[\w$]/.test(code[w - 1])) w--
      return REGEX_AFTER.has(code.slice(w, k + 1).join(""))
    }
    return !/[)\]"'`]/.test(code[k])
  }
  while (i < n) {
    const c = text[i]
    const d = text[i + 1]
    if (c === "/" && d === "/") {
      const end = text.indexOf("\n", i)
      const e = end < 0 ? n : end
      blank(code, i, e)
      blank(bare, i, e)
      i = e
    } else if (c === "/" && d === "*") {
      const end = text.indexOf("*/", i + 2)
      const e = end < 0 ? n : end + 2
      blank(code, i, e)
      blank(bare, i, e)
      i = e
    } else if (c === '"' || c === "'") {
      let j = i + 1
      while (j < n && text[j] !== c && text[j] !== "\n") j += text[j] === "\\" ? 2 : 1
      blank(bare, i + 1, Math.min(j, n))
      i = j + 1
    } else if (c === "`") {
      i++
      templateText()
    } else if (c === "/" && regexAllowed()) {
      let j = i + 1
      let inClass = false
      while (j < n && text[j] !== "\n" && (inClass || text[j] !== "/")) {
        if (text[j] === "[") inClass = true
        else if (text[j] === "]") inClass = false
        j += text[j] === "\\" ? 2 : 1
      }
      blank(bare, i + 1, Math.min(j, n))
      i = j + 1
    } else if (c === "}" && templates.at(-1) === depth - 1) {
      templates.pop()
      depth--
      i++
      templateText()
    } else {
      if (c === "{") depth++
      else if (c === "}") depth--
      i++
    }
  }
  return { code: code.join(""), bare: bare.join("") }
}

const OPEN = "([{"
const CLOSE = ")]}"
const nextSig = (bare, i) => {
  while (i < bare.length && /\s/.test(bare[i])) i++
  return i
}

// End of the expression starting at `from`: a top-level `,` or `;`, an unmatched closing bracket,
// or a line end the next line does not continue.
function exprEnd(bare, from) {
  let depth = 0
  let last = ""
  for (let i = from; i < bare.length; i++) {
    const c = bare[i]
    if (OPEN.includes(c)) depth++
    else if (CLOSE.includes(c)) {
      if (depth === 0) return i
      depth--
    } else if (depth === 0 && (c === "," || c === ";")) return i
    else if (depth === 0 && c === "\n" && last !== "") {
      const after = bare.slice(nextSig(bare, i), nextSig(bare, i) + 10)
      const continues =
        /[=+\-*/%&|^!?:,(<>]/.test(last) || /^([.+\-*/%&|^?:]|as\b|satisfies\b)/.test(after)
      if (!continues) return i
    }
    if (!/\s/.test(c)) last = c
  }
  return bare.length
}

// Index of the bracket closing the one at `open`.
function closing(bare, open) {
  let depth = 0
  for (let i = open; i < bare.length; i++) {
    if (OPEN.includes(bare[i])) depth++
    else if (CLOSE.includes(bare[i]) && --depth === 0) return i
  }
  return bare.length
}

// Splits at each top-level `sep`.
function splitTop(code, bare, sep) {
  const parts = []
  let depth = 0
  let start = 0
  for (let i = 0; i < bare.length; i++) {
    const c = bare[i]
    if (OPEN.includes(c)) depth++
    else if (CLOSE.includes(c)) depth--
    else if (depth === 0 && c === sep && bare[i + 1] !== sep && bare[i + 1] !== "=") {
      if (sep === "+" && bare[i - 1] === "+") continue
      parts.push(code.slice(start, i))
      start = i + 1
    }
  }
  parts.push(code.slice(start))
  return parts
}

// The value expression of a function body: its only `return` of something other than null or
// undefined, else none.
function returned(code, bare, open) {
  const values = [...bare.slice(open, closing(bare, open)).matchAll(/\breturn\b/g)]
    .map((m) => open + m.index + 6)
    .map((from) => code.slice(from, exprEnd(bare, from)).trim())
    .filter((expr) => !/^(null|undefined|)$/.test(expr))
  return values.length === 1 ? values[0] : undefined
}

// Words before a `(` whose list is no parameter list.
const NOT_PARAMS = new Set(["if", "for", "while", "switch", "with"])
// A parameter: its name and type annotation; a destructuring pattern is none.
const PARAM =
  /^(?:\.\.\.|(?:public|private|protected|readonly|override)\s+)*([\w$]+)\s*\??\s*(?::([\s\S]*))?$/
const ARROW = /^(?:async\s+)?(?:\([^()]*\)|[\w$]+)\s*(?::[^=]*)?=>\s*/

/** The declarations a key can resolve through, with the block each one is visible in. */
function scopeOf(text) {
  const { code, bare } = lex(text)
  const blocks = []
  const stack = []
  for (let i = 0; i < bare.length; i++) {
    if (bare[i] === "{") stack.push(i)
    else if (bare[i] === "}" && stack.length) blocks.push([stack.pop(), i])
  }
  const visibility = (at) =>
    blocks.reduce(
      (best, b) => (b[0] < at && at < b[1] && b[0] > best[0] ? b : best),
      [-1, Infinity],
    )
  const decls = []
  for (const m of bare.matchAll(/\b(?:const|let|var)\s+([\w$]+)\s*(?::[^=;\n]*)?=(?![=>])/g)) {
    const from = m.index + m[0].length
    let expr = code.slice(from, exprEnd(bare, from)).trim()
    let fn = false
    const arrow = ARROW.exec(expr)
    if (arrow) {
      fn = true
      const body = from + code.slice(from).indexOf(expr) + arrow[0].length
      expr = bare[body] === "{" ? returned(code, bare, body) : expr.slice(arrow[0].length)
    }
    decls.push({ name: m[1], at: m.index, expr, fn, block: visibility(m.index) })
  }
  for (const m of bare.matchAll(/\bfunction\s+([\w$]+)\s*(?:<[^(]*>)?\s*\(/g)) {
    const params = closing(bare, m.index + m[0].length - 1)
    const body = bare.indexOf("{", params)
    if (body < 0) continue
    const expr = returned(code, bare, body)
    decls.push({ name: m[1], at: m.index, expr, fn: true, block: visibility(m.index) })
  }
  const sigBefore = (i) => {
    while (i > 0 && /\s/.test(bare[i - 1])) i--
    return i - 1
  }
  const wordBefore = (i) => {
    const end = sigBefore(i) + 1
    let w = end
    while (w > 0 && /[\w$]/.test(bare[w - 1])) w--
    return bare.slice(w, end)
  }
  // A function body: its block, or the arrow's expression from `start`.
  const body = (from, start) => {
    const open = nextSig(bare, from)
    return bare[open] === "{" ? [open, closing(bare, open)] : [start, exprEnd(bare, open)]
  }
  const param = (text, at, block) => {
    const m = PARAM.exec(text.trim())
    const type = KEY_TYPE.exec((m?.[2] ?? "").trim())?.[1]
    if (m) decls.push({ name: m[1], at, param: true, type, block })
  }
  const after = /\s*(?::\s*[^\s=;{}()][^=;{}()]*)?(=>|\{)/y
  for (let open = bare.indexOf("("); open >= 0; open = bare.indexOf("(", open + 1)) {
    const close = closing(bare, open)
    after.lastIndex = close + 1
    const m = after.exec(bare)
    if (!m || (m[1] === "{" && NOT_PARAMS.has(wordBefore(open)))) continue
    const block = body(m[1] === "{" ? after.lastIndex - 1 : after.lastIndex, close)
    const list = [code.slice(open + 1, close), bare.slice(open + 1, close)]
    for (const p of splitTop(...list, ",")) param(p, open, block)
  }
  for (const m of bare.matchAll(/(?<![\w$.])([\w$]+)\s*=>/g)) {
    if (m[1] !== "async" && !/[:|&]/.test(bare[sigBefore(m.index)]))
      param(m[1], m.index, body(m.index + m[0].length, m.index + m[1].length))
  }
  return { code, bare, decls }
}

// The declaration in the innermost scope visible at `at`.
function lookup(scope, name, at) {
  const visible = scope.decls.filter((d) => d.name === name && d.block[0] < at && at < d.block[1])
  const inner = Math.max(...visible.map((d) => d.block[0]))
  const own = visible.filter((d) => d.block[0] === inner)
  return own.filter((d) => d.at < at).at(-1) ?? own[0]
}

/** A key expression as a string; `*` marks a part not resolved in the file. */
function resolveKey(scope, expr, at, depth = 0) {
  if (depth > 8 || expr === undefined) return UNKNOWN
  let e = expr.trim().replace(/\s+(as|satisfies)\s+[\w$.<>[\]| "']+$/, "")
  let { bare } = lex(e)
  while (e.startsWith("(") && closing(bare, 0) === e.length - 1) {
    e = e.slice(1, -1).trim()
    bare = lex(e).bare
  }
  const parts = splitTop(e, bare, "+")
  if (parts.length > 1)
    return parts
      .map((p) => resolveKey(scope, p, at, depth + 1))
      .join("")
      .replace(/\*+/g, UNKNOWN)
  if (/^["']/.test(e)) return bare.indexOf(e[0], 1) === e.length - 1 ? e.slice(1, -1) : UNKNOWN
  if (e.startsWith("`")) {
    let out = ""
    for (let i = 1; i < e.length; i++) {
      if (e[i] === "\\") out += e[++i]
      else if (e[i] === "$" && e[i + 1] === "{") {
        const end = closing(bare, i + 1)
        out += resolveKey(scope, e.slice(i + 2, end), at, depth + 1)
        i = end
      } else if (e[i] === "`") return i === e.length - 1 ? out.replace(/\*+/g, UNKNOWN) : UNKNOWN
      else out += e[i]
    }
    return UNKNOWN
  }
  let m
  if (/^[\w$]+$/.test(e)) {
    const decl = lookup(scope, e, at)
    if (decl?.param) return decl.type ? `<${decl.type}>` : UNKNOWN
    return decl && !decl.fn ? resolveKey(scope, decl.expr, decl.at, depth + 1) : UNKNOWN
  }
  if ((m = /^([\w$]+)\.([\w$]+)$/.exec(e))) {
    const decl = lookup(scope, m[1], at)
    if (!decl || decl.fn || !decl.expr?.startsWith("{")) return UNKNOWN
    const inner = decl.expr.slice(1, closing(lex(decl.expr).bare, 0))
    for (const entry of splitTop(inner, lex(inner).bare, ",")) {
      const prop = /^\s*["']?([\w$-]+)["']?\s*:/.exec(entry)
      if (prop?.[1] === m[2])
        return resolveKey(scope, entry.slice(prop[0].length), decl.at, depth + 1)
    }
    return UNKNOWN
  }
  if ((m = /^([\w$]+)\s*\(/.exec(e)) && closing(bare, m[0].length - 1) === e.length - 1) {
    const decl = lookup(scope, m[1], at)
    return decl?.fn ? resolveKey(scope, decl.expr, decl.at, depth + 1) : UNKNOWN
  }
  return UNKNOWN
}

// The first argument of the call whose `(` is at `open`.
function firstArg(scope, open) {
  return scope.code.slice(open + 1, exprEnd(scope.bare, open + 1))
}

const KEYED_CALL = new RegExp(
  String.raw`(?<![.\w$])(?:(deviceStorage|rollupStorage)|(?:(?:window|globalThis)\.)?` +
    String.raw`(localStorage|sessionStorage))\s*\??\.\s*(?:getItem|setItem|removeItem)\s*\(`,
  "g",
)
const keyLabel = (key) => (key.startsWith(UNKNOWN) ? "?" : key)

/**
 * Each legacy channel a file persists state through, with the offset of its first use; empty when
 * the file is no legacy store or is excluded.
 */
export function storeSites(file, text) {
  if (!isWalletSource(file) || isStorageMigration(file)) return []
  if (CHANNEL_IMPLEMENTATIONS.some((p) => (p.endsWith("/") ? file.startsWith(p) : file === p)))
    return []
  const { bare } = lex(text)
  const channels = new Map()
  const add = (channel, at) => channels.has(channel) || channels.set(channel, at)
  for (const [channel, pattern] of [
    ["adapter", /:\s*(?:[\w$]+\s*<\s*)?IStorageAdapter\b|\bimplements\s+IStorageAdapter\b/],
    ["recordStorage", /\b(?:new|extends)\s+RecordStorage\b/],
    ["webStorage", /(?<![.\w$])webStorage\s*\.\s*(?:getItem|setItem|removeItem)\s*\(/],
    ["walletStorage", /(?<![.\w$])walletStorage\s*\??\./],
    ["stringStoreDefault", /:\s*StringStore\s*=\s*(?:window\.|globalThis\.)?sessionStorage\b/],
  ]) {
    const at = pattern.exec(bare)?.index
    if (at !== undefined) add(channel, at)
  }

  let scope
  const keyAt = (open) => {
    scope ??= scopeOf(text)
    return resolveKey(scope, firstArg(scope, open), open)
  }
  for (const m of bare.matchAll(KEYED_CALL)) {
    const channel = m[1] ?? m[2]
    const key = keyAt(m.index + m[0].length - 1)
    if (!isAllowedKey(channel, key)) add(`${channel}:${keyLabel(key)}`, m.index)
  }
  const aliases = [...bare.matchAll(/\btype\s+([\w$]+)\s*=\s*typeof\s+tabStash\b/g)].map(
    (m) => m[1],
  )
  const seamType = ["typeof\\s+tabStash", ...aliases].join("|")
  const stashes = new Set(["tabStash"])
  for (const m of bare.matchAll(new RegExp(`\\b([\\w$]+)\\??\\s*:\\s*(?:${seamType})\\b`, "g")))
    stashes.add(m[1])
  const stashCall = new RegExp(
    `(?<![.\\w$])(?:${[...stashes].join("|")})\\s*\\??\\.\\s*(?:get|set|remove)\\s*\\(`,
    "g",
  )
  for (const m of bare.matchAll(stashCall)) {
    const key = keyAt(m.index + m[0].length - 1)
    if (!isAllowedKey("tabStash", key)) add(`tabStash:${keyLabel(key)}`, m.index)
  }
  for (const m of bare.matchAll(/(?<![.\w$])w\s*\.\s*put\s*\(/g))
    if (keyAt(m.index + m[0].length - 1).startsWith("@obsidion/")) add("rootCursor", m.index)
  return [...channels].map(([channel, at]) => ({ channel, at }))
}

/** The legacy channels a file persists state through, sorted. */
export const storeChannels = (file, text) => storeSites(file, text).map((s) => s.channel).sort()

/** A file's repository path, from its path on disk. */
export const repoPath = (file) =>
  /(?:^|[\\/])(packages[\\/](?:front-core|web-wallet|passkey-web)[\\/].*)$/.exec(file)?.[1].replace(/\\/g, "/")
