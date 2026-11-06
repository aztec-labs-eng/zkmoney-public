import { execFileSync } from "node:child_process"
import { readdirSync, readFileSync } from "node:fs"
import path from "node:path"

const STANDARDS = new Set(
  "AES AGPL BIP BSD EIP ENSIP ERC GPL ISO LGPL MPL RFC RSA SHA USD UTF".split(" "),
)

const standard = (match) => STANDARDS.has(match[0].split("-")[0].toUpperCase())
const isCss = (file) => /\.s?css$/.test(file)

const RULES = [
  [
    "private link",
    /\blinear\.app\/[\w/.-]*|\b[\w-]+\.slack\.com\b[\w/.-]*|\bgithub\.com\/aztec-labs-eng\/(?!(?:zkmoney-public|aztec-node)(?![\w.-]))[\w.-]+/gi,
  ],
  ["ticket ID", /(?<![\w.$-])[A-Z]{2,5}-\d{2,}(?!\w)/g, { skip: standard }],
  [
    "ticket ID",
    /(?<![\w.$-])(?:gk|ktd|ox|ult|zkm)-[1-9]\d*(?!\w|\.\d)/gi,
    { skip: (match) => standard(match) || /^[A-Z]+-\d{2,}$/.test(match[0]) },
  ],
  ["ticket ID", /(?<![\w.$-])F-[1-9]\d+(?!\w)/g, { skip: standard }],
  ["AWS host", /\b[\w.-]+\.(?:cloudfront\.net|amazonaws\.com)\b/gi],
  [
    "internal IP",
    /(?<![\w.])(?:10(?:\.\d{1,3}){3}|172\.(?:1[6-9]|2\d|3[01])(?:\.\d{1,3}){2}|192\.168(?:\.\d{1,3}){2})\b/g,
  ],
  ["SSM name", /(?<![\w@./-])\/obsidion\/[\w-]+(?:\/[\w-]+)*|\barn:aws:ssm:[^\s"'`]*/g],
  [
    "token",
    /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b|\bgh[pousr]_\w{36,}|\bgithub_pat_\w{22,}|\bxox[abposr]-[\w-]{10,}|-----BEGIN [A-Z ]*PRIVATE KEY-----|\blin_api_\w{20,}|\bsk-ant-[\w-]{20,}|alchemy\.com\/v2\/[\w-]{16,}|infura\.io\/v3\/[0-9a-f]{32}/g,
  ],
  ["PR number", /(?<=^|[\s(])#\d{2,5}(?=$|[\s).,:])/g, { inComments: true }],
]

const findings = ({ text, comments = text }) =>
  RULES.flatMap(([kind, pattern, { skip = () => false, inComments = false } = {}]) =>
    [...(inComments ? comments : text).matchAll(pattern)]
      .filter((match) => !skip(match))
      .map((match) => ({ kind, item: match[0], at: match.index })),
  ).sort((a, b) => a.at - b.at)

const commentsOf = (content) => {
  let open = false
  return content.split("\n").map((line) => {
    let rest = false
    return line.replace(/\/\*|\*\/|\/\/|[^]/g, (token) => {
      if (token === "/*" && !rest) open = true
      else if (token === "//" && !open) rest = true
      const kept = open || rest
      if (token === "*/") open = false
      return kept ? token : " ".repeat(token.length)
    })
  })
}

const newSide = (range, file) => {
  const head = range.split(/\.\.\.?/)[1]
  if (head === undefined) return readFileSync(file, "utf8")
  return execFileSync("git", ["show", `${head || "HEAD"}:${file}`], {
    encoding: "utf8",
    maxBuffer: 1 << 30,
  })
}

function addedLines(range) {
  const diff = execFileSync(
    "git",
    ["-c", "core.quotePath=false", "diff", "--no-color", "--no-ext-diff", "-M", "-U0", range],
    { encoding: "utf8", maxBuffer: 1 << 30 },
  )
  const added = []
  const removed = new Map()
  let file, line, hunk
  for (const text of diff.split("\n")) {
    if (text.startsWith("diff --git ")) hunk = false
    else if (!hunk && text.startsWith("+++ ")) file = text.slice(6)
    else if (text.startsWith("@@ ")) [hunk, line] = [true, Number(/\+(\d+)/.exec(text)[1])]
    else if (hunk && text.startsWith("+")) added.push({ file, line: line++, text: text.slice(1) })
    else if (hunk && text.startsWith("-")) {
      const key = text.slice(1).trim()
      removed.set(key, (removed.get(key) ?? 0) + 1)
    }
  }
  const comments = new Map()
  return added.filter((entry) => {
    const count = removed.get(entry.text.trim())
    if (count) removed.set(entry.text.trim(), count - 1)
    if (count || !isCss(entry.file)) return !count
    if (!comments.has(entry.file)) comments.set(entry.file, commentsOf(newSide(range, entry.file)))
    entry.comments = comments.get(entry.file)[entry.line - 1]
    return true
  })
}

const filesIn = (dir) =>
  readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => path.join(entry.parentPath, entry.name))
    .sort()

const textLines = (dir) =>
  filesIn(dir).flatMap((file) => {
    const data = readFileSync(file)
    if (data.includes(0)) return []
    const name = path.relative(dir, file)
    const content = data.toString("utf8")
    const comments = isCss(name) ? commentsOf(content) : []
    return content
      .split("\n")
      .map((text, i) => ({ file: name, line: i + 1, text, comments: comments[i] }))
  })

const key = ({ kind, item }) => `${kind}\0${item}`

const args = process.argv.slice(2)
if (args.length < 1 || args.length > 2) {
  console.error(
    "Usage: node scan.mjs <git range>, or node scan.mjs <bundle dir> <baseline bundle dir>",
  )
  process.exit(2)
}
const [target, baseline] = args
const lines = baseline ? textLines(target) : addedLines(target)
const known = new Set(
  baseline ? textLines(baseline).flatMap((entry) => findings(entry).map(key)) : [],
)
let count = 0
for (const entry of lines)
  for (const finding of findings(entry)) {
    if (known.has(key(finding))) continue
    console.log(`${entry.file}:${entry.line}: ${finding.kind}: ${finding.item}`)
    count++
  }
console.error(`${count} forbidden items`)
if (count) process.exitCode = 1
