import assert from "node:assert/strict"
import { spawnSync, execFileSync } from "node:child_process"
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { test } from "node:test"
import { fileURLToPath } from "node:url"

const scan = path.join(path.dirname(fileURLToPath(import.meta.url)), "scan.mjs")

const run = (cwd, ...args) => {
  const { status, stdout } = spawnSync("node", [scan, ...args], { cwd, encoding: "utf8" })
  return { status, lines: stdout.split("\n").filter(Boolean) }
}

const write = (root, files) => {
  for (const [name, content] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(root, name)), { recursive: true })
    writeFileSync(path.join(root, name), content)
  }
}

const repo = (before, after) => {
  const root = mkdtempSync(path.join(tmpdir(), "scan-"))
  const git = (...args) =>
    execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd: root })
  git("init", "-q")
  for (const files of [before, after]) {
    write(root, files)
    git("add", "-A")
    git("commit", "-q", "--allow-empty", "-m", "c")
  }
  return root
}

test("reports a ticket ID in an added line with its file and line", () => {
  const root = repo({ "a.ts": "one\n" }, { "a.ts": "one\n// funnel (ABC-123): shown\n" })
  assert.deepEqual(run(root, "HEAD~1..HEAD"), {
    status: 1,
    lines: ["a.ts:2: ticket ID: ABC-123"],
  })
})

test("ignores standard names, member arithmetic and versions", () => {
  const added = 'SHA-256 UTF-8 ERC-20 AES-128-CBC CC-BY-4.0 t.BITS-1 noir-0.36.0 r=F-1 "#123"\n'
  assert.deepEqual(run(repo({}, { "a.ts": added }), "HEAD~1..HEAD"), { status: 0, lines: [] })
})

test("ignores removed lines and moved lines", () => {
  const root = repo(
    { "a.ts": "x\n// AB-12 note\n// PR #12 note\n" },
    { "a.ts": "x\n", "b.ts": "  // PR #12 note\n" },
  )
  assert.deepEqual(run(root, "HEAD~1..HEAD"), { status: 0, lines: [] })
})

test("reports the lowercase IDs of known teams, 1-letter keys and bare PR numbers", () => {
  const root = repo(
    {},
    {
      "a.ts": 'mkdtemp("ult-12-app-")\n// TODO(F-12): x\n// after (#12). See issue #345, and #6.\n',
      "b.css": "a { color: #333 !important } /* see #12 */\n",
    },
  )
  assert.deepEqual(run(root, "HEAD~1..HEAD"), {
    status: 1,
    lines: [
      "a.ts:1: ticket ID: ult-12",
      "a.ts:2: ticket ID: F-12",
      "a.ts:3: PR number: #12",
      "a.ts:3: PR number: #345",
      "b.css:1: PR number: #12",
    ],
  })
})

test("reports each kind of private item", () => {
  const added = [
    "https://linear.app/team/issue/AB-1/x",
    "https://team.slack.com/archives/C0",
    "https://github.com/aztec-labs-eng/private-repo/pull/1",
    "https://github.com/aztec-labs-eng/zkmoney-public/pull/23 github.com/aztec-labs-eng/aztec-node",
    "d1234abcd.cloudfront.net",
    "bucket.s3.us-east-1.amazonaws.com",
    "10.0.12.7 192.168.1.20 172.20.0.3 8.8.8.8",
    'aws ssm get-parameter --name "/obsidion/env/facts/name"',
    "@obsidion/core packages/obsidion/x",
    "AKIAIOSFODNN7EXAMPLE",
    "-----BEGIN EC PRIVATE KEY-----",
    "see PR #12",
  ].join("\n")
  assert.deepEqual(run(repo({}, { "a.md": `${added}\n` }), "HEAD~1..HEAD"), {
    status: 1,
    lines: [
      "a.md:1: private link: linear.app/team/issue/AB-1/x",
      "a.md:1: ticket ID: AB-1",
      "a.md:2: private link: team.slack.com/archives/C0",
      "a.md:3: private link: github.com/aztec-labs-eng/private-repo",
      "a.md:5: AWS host: d1234abcd.cloudfront.net",
      "a.md:6: AWS host: bucket.s3.us-east-1.amazonaws.com",
      "a.md:7: internal IP: 10.0.12.7",
      "a.md:7: internal IP: 192.168.1.20",
      "a.md:7: internal IP: 172.20.0.3",
      "a.md:8: SSM name: /obsidion/env/facts/name",
      "a.md:10: token: AKIAIOSFODNN7EXAMPLE",
      "a.md:11: token: -----BEGIN EC PRIVATE KEY-----",
      "a.md:12: PR number: #12",
    ],
  })
})

test("reports only the bundle items that the baseline does not have", () => {
  const baseline = mkdtempSync(path.join(tmpdir(), "scan-baseline-"))
  const bundle = mkdtempSync(path.join(tmpdir(), "scan-bundle-"))
  const known = "// https://linear.app/team/issue/AB-1/x\n"
  write(baseline, { "assets/old-A1.js": known })
  write(bundle, {
    "assets/old-B2.js": `changed ${known}`,
    "assets/new-C3.js": "a\nb // TODO(ABC-12)\n",
    "assets/logo.png": Buffer.from([0x89, 0x50, 0x00, 0x4c, 0x4d, 0x2d, 0x32]),
  })
  assert.deepEqual(run(tmpdir(), bundle, baseline), {
    status: 1,
    lines: ["assets/new-C3.js:2: ticket ID: ABC-12"],
  })
})

test("fails with usage text for a wrong count of arguments", () => {
  assert.equal(run(tmpdir()).status, 2)
})
