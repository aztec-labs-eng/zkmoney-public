import { execFileSync } from "node:child_process"
import { readdirSync, readFileSync } from "node:fs"
import path from "node:path"

const STANDARDS = new Set(
  "AES AGPL BIP BSD EIP ENSIP ERC GPL ISO LGPL MPL RFC RSA SHA USD UTF".split(" "),
)

const RULES = [
  [
    "private link",
    /\blinear\.app\/[\w/.-]*|\b[\w-]+\.slack\.com\b[\w/.-]*|\bgithub\.com\/aztec-labs-eng\/(?!(?:zkmoney-public|aztec-node)(?![\w.-]))[\w.-]+/gi,
  ],
  ["ticket ID", /(?<![\w.$-])([A-Z]{2,5})-\d+(?!\w)/g],
  ["ticket ID", /(?<![\w.$-])(?:gk|ktd|ox|ult|zkm)-[1-9]\d*(?!\w|\.\d)/gi],
  ["ticket ID", /(?<![\w.$-])F-[1-9]\d+(?!\w)/g],
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
  ["PR number", /(?<=^|[\s(])#\d{2,5}(?=$|[\s).,:])/g, (file) => /\.s?css$/.test(file)],
]

const commentStart = (text) => {
  const at = text.search(/\/[*/]/)
  return at < 0 ? text.length : at
}

const findings = (file, text) =>
  RULES.flatMap(([kind, pattern, commentsOnly]) => {
    const from = commentsOnly?.(file) ? commentStart(text) : 0
    return [...text.slice(from).matchAll(pattern)]
      .filter((match) => kind !== "ticket ID" || !STANDARDS.has(match[1]))
      .map((match) => ({ kind, item: match[0], at: from + match.index }))
  })
    .filter((a, i, all) => all.findIndex((b) => b.at === a.at && b.item === a.item) === i)
    .sort((a, b) => a.at - b.at)

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
  return added.filter(({ text }) => {
    const count = removed.get(text.trim())
    if (count) removed.set(text.trim(), count - 1)
    return !count
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
    return data
      .toString("utf8")
      .split("\n")
      .map((text, i) => ({ file: name, line: i + 1, text }))
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
  baseline ? textLines(baseline).flatMap(({ file, text }) => findings(file, text).map(key)) : [],
)
let count = 0
for (const { file, line, text } of lines)
  for (const finding of findings(file, text)) {
    if (known.has(key(finding))) continue
    console.log(`${file}:${line}: ${finding.kind}: ${finding.item}`)
    count++
  }
console.error(`${count} forbidden items`)
if (count) process.exitCode = 1
