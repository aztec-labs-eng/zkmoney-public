import assert from "node:assert/strict"
import { test } from "node:test"
import { ESLint } from "eslint"
import { migrated } from "../index.mjs"

const eslint = new ESLint({
  cwd: import.meta.dirname,
  overrideConfigFile: true,
  overrideConfig: migrated({
    tsconfigRootDir: import.meta.dirname,
    debt: true,
    react: ["src/probe.ts"],
  }),
})
const lint = async (code) => {
  const [result] = await eslint.lintText(code, { filePath: `${import.meta.dirname}/src/probe.ts` })
  return result.messages
}
// The messages a rule reports; the disable checks share one rule, so they also match a message id.
const by = (messages, ruleId, messageId) =>
  messages.filter((m) => m.ruleId === ruleId && (messageId === undefined || m.messageId === messageId))
const count = (messages, ruleId, messageId) => by(messages, ruleId, messageId).length
const effect = (messages) => by(messages, "local/effect-hook")

test("an effect hook through any name of react's module is effect debt", async () => {
  for (const code of [
    'import { useEffect } from "react"\nuseEffect(() => {}, [])\n',
    'import { useEffect as run } from "react"\nrun(() => {}, [])\n',
    'import React from "react"\nReact.useEffect(() => {}, [])\n',
    'import R from "react"\nR.useEffect(() => {}, [])\n',
    'import * as R from "react"\nR.useEffect(() => {}, [])\n',
    'import { default as R } from "react"\nR.useEffect(() => {}, [])\n',
  ])
    assert.ok(effect(await lint(code)).length > 0, code)
})

test("each effect hook call is its own debt; the import is none", async () => {
  const twice = 'import { useEffect } from "react"\nuseEffect(() => {}, [])\nuseEffect(() => {}, [])\n'
  assert.equal(effect(await lint(twice)).length, 2)
  assert.deepEqual(effect(await lint('import { useEffect } from "react"\nexport { useState } from "x"\n')), [])
})

const aliased = (messages) =>
  count(messages, "local/hook-alias") + count(messages, "no-restricted-syntax") > 0
test("an alias of react or of an effect hook is banned, and its calls stay effect debt", async () => {
  for (const [code, calls] of [
    ['import R from "react"\nconst react = R\nreact.useEffect(() => {}, [])\n', 1],
    ['import * as R from "react"\nconst { useEffect: run } = { useEffect: R.useEffect }\nexport { R }\n', 1],
    ['import { useEffect } from "react"\nconst run = useEffect\nrun(() => {}, [])\nrun(() => {}, [])\n', 2],
    ['import R from "react"\nconst run = R.useEffect\nrun(() => {}, [])\n', 1],
    ['import { default as R } from "react"\nconst react = R\nreact.useEffect(() => {}, [])\n', 1],
  ]) {
    const messages = await lint(code)
    assert.ok(aliased(messages), code)
    assert.equal(effect(messages).length, calls, code)
  }
})

test("react's other hooks are not effect debt", async () => {
  assert.deepEqual(effect(await lint('import { useState } from "react"\nuseState(0)\n')), [])
})

const disables = (messages, messageId) => count(messages, "local/tagged-disable", messageId)
test("a comment that configures rules fails, quoted or not", async () => {
  for (const comment of [
    '/* eslint "no-restricted-syntax": "off", "local/page-singleton": "off" */',
    "/* eslint no-restricted-syntax: 0 */",
    '/*eslint "local/tagged-disable": "warn"*/',
  ])
    assert.equal(disables(await lint(`${comment}\nexport const a = 1\n`), "inline"), 1, comment)
})

const swallows = async (handler) =>
  count(await lint(`export const p = (q: Promise<number>) => q.catch(${handler})\n`), "local/no-swallow") > 0
test("a rejection handler that yields a value without reading its error swallows it", async () => {
  for (const handler of [
    "(err) => undefined",
    '(err) => "fallback"',
    "() => null",
    "(_e) => 0",
    "function (err) { return [] }",
  ])
    assert.ok(await swallows(handler), handler)
})

test("a rejection handler that reads or rethrows its error passes", async () => {
  for (const handler of ["(e) => e", "(e) => e.message", "(e) => { throw e }"])
    assert.equal(await swallows(handler), false, handler)
})

const moduleState = async (code) => count(await lint(code), "no-restricted-syntax")
test("a top-level class instance or static instance is module state", async () => {
  for (const code of [
    "class Driver {}\nexport const driver = new Driver()\n",
    "export const held = { store: new Driver() }\n",
    "export const shared = Driver.instance\n",
  ])
    assert.equal(await moduleState(code), 1, code)
})

test("a value builtin or an instance made per call is not module state", async () => {
  for (const code of [
    "export const encoder = new TextEncoder()\n",
    'export const format = new Intl.DateTimeFormat("en-US")\n',
    "export const bytes = new Uint8Array([1])\n",
    "export const make = () => new Driver()\n",
  ])
    assert.equal(await moduleState(code), 0, code)
})

test("the contract service's static instance is a page singleton through any import", async () => {
  for (const code of [
    'import { ContractService } from "@obsidion/sdk"\nexport const s = () => ContractService.getInstance()\n',
    'import { ContractService as C } from "@obsidion/sdk"\nexport const s = () => C.getInstance()\n',
    'import * as sdk from "@obsidion/sdk"\nexport const s = () => sdk.ContractService.getInstance()\n',
  ])
    assert.equal(count(await lint(code), "local/page-singleton"), 1, code)
})

const held = async (code) => count(await lint(code), "local/held-service")
test("each useResource call or alias is debt, through any import of the hook", async () => {
  for (const code of [
    'import { useResource } from "@obsidion/front-core"\nexport const a = (s: any) => useResource(s.wallet)\n',
    'import { useResource } from "@obsidion/front-core"\nexport const a = (s: any) => useResource(s.token)\n',
    'import { useResource as r } from "@obsidion/front-core/hooks"\nexport const a = (s: any) => r(s?.contractService)\n',
    'import * as fc from "@obsidion/front-core"\nexport const a = (s: any) => fc.useResource(s.savings)\n',
    'import { useResource } from "../hooks/useResource"\nexport const a = (wallet: any) => useResource(wallet)\n',
    'import { useResource } from "@obsidion/front-core"\nexport const read = useResource\n',
  ])
    assert.equal(await held(code), 1, code)
  const twice = 'import { useResource } from "@obsidion/front-core"\nexport const a = (s: any) => [useResource(s.a), useResource(s.b)]\n'
  assert.equal(await held(twice), 2)
})

test("another module's useResource, or a type of the hook, is no held service", async () => {
  for (const code of [
    'import { useResource } from "./other"\nexport const a = (s: any) => useResource(s.wallet)\n',
    'import type { useResource } from "@obsidion/front-core"\nexport type R = typeof useResource\n',
  ])
    assert.equal(await held(code), 0, code)
})

test("a block or file-wide disable fails, tagged or not, with or without rules", async () => {
  for (const comment of [
    "/* eslint-disable -- ZKM-1778 */",
    "/* eslint-disable no-restricted-syntax -- ZKM-1778 */",
    "/* eslint-disable */",
    "// eslint-disable -- ZKM-1778",
  ])
    assert.equal(disables(await lint(`${comment}\nexport let held = 1\n`), "range"), 1, comment)
})

test("a disable quoted in a string or template is no comment", async () => {
  for (const code of [
    'export const example = "/* eslint-disable -- ZKM-1778 */"\n',
    "export const example = `\n/* eslint-disable */\n// eslint-disable -- ZKM-1778\n`\n",
    "/* eslint-disable */\nexport const example = `/* eslint-disable */`\n",
  ])
    assert.equal(disables(await lint(code), "range"), code.startsWith("/*") ? 1 : 0, code)
})

test("a tagged next-line disable passes", async () => {
  const code = "// eslint-disable-next-line no-restricted-syntax -- ZKM-1778\nexport let held = 1\n"
  assert.deepEqual(await lint(code), [])
})

const lintAt = async (file, code) => {
  const [result] = await eslint.lintText(code, { filePath: `${import.meta.dirname}/${file}` })
  return result.messages
}

const CURRENT = "local/session-accessor"
test("code outside React reads no current session, through any import", async () => {
  for (const [code, reads] of [
    ['import { openedSession } from "../session/session"\nexport const a = () => openedSession.get()\n', 1],
    ['import { openedSession as o } from "./session"\nexport const a = () => o.get()\n', 1],
    ['import { session } from "../../session/session"\nexport const a = () => [session(), session()]\n', 2],
    ['import * as s from "../session/session"\nexport const a = () => [s.session(), s.openedSession.get()]\n', 2],
    ['export const a = async () => {\n  const { session: o } = await import("../session/session")\n  return o()\n}\n', 1],
    ['export const a = async () => {\n  const m = await import("../session/session")\n  return m.openedSession.get()\n}\n', 1],
    ['export const a = async () => (await import("../session/session")).session()\n', 1],
    ['export const a = async () => {\n  let m: any\n  m = await import("../session/session")\n  return m.session()\n}\n', 1],
    ['export const a = async () => {\n  let o: any\n  ;({ openedSession: o } = await import("../session/session"))\n  return o.get()\n}\n', 1],
  ])
    assert.equal(count(await lintAt("src/flow.ts", code), CURRENT), reads, code)
  const script = 'import { openedSession } from "../src/session/session"\nexport const a = () => openedSession.get()\n'
  assert.equal(count(await lintAt("scripts/fixture.ts", script), CURRENT), 1)
  assert.equal(count(await lintAt("src/flow.test.ts", script), CURRENT), 1)
})

test("a subscription, a type, another module, the defining module and a test read no current session", async () => {
  for (const [file, code] of [
    ["src/View.tsx", 'import { openedSession } from "../session/session"\nexport const a = (u: any) => u(openedSession)\n'],
    ["src/flow.ts", 'import type { Session } from "../session/session"\nexport const a = (s: Session) => s\n'],
    ["src/flow.ts", 'import { session } from "../dev/demoFlag"\nexport const a = () => session()\n'],
    ["src/session/session.ts", "const c: any = 0\nexport const openedSession = c\nexport const a = () => openedSession.get()\n"],
    ["test/flow.test.ts", 'import { openedSession } from "../src/session/session"\nopenedSession.get()\n'],
  ])
    assert.equal(count(await lintAt(file, code), CURRENT), 0, `${file}: ${code}`)
})

test("a disable in any package file names its issue and disables one line", async () => {
  for (const file of ["test/view.test.tsx", "scripts/fixture.ts", "e2e/support.ts", "vite.config.ts"]) {
    const untagged = "// eslint-disable-next-line no-restricted-syntax\nexport const a = 1\n"
    assert.equal(disables(await lintAt(file, untagged), "untagged"), 1, file)
    assert.equal(disables(await lintAt(file, "/* eslint-disable -- ZKM-1778 */\nexport const a = 1\n"), "range"), 1, file)
  }
})

test("a same-line disable cannot hide its own missing rules or tag", async () => {
  for (const file of ["src/probe.ts", "test/view.test.tsx"]) {
    const messages = await lintAt(file, "export const a = 1 // eslint-disable-line\n")
    assert.equal(disables(messages, "ruleless"), 1, file)
    const named = await lintAt(file, "export const a = 1 // eslint-disable-line local/tagged-disable\n")
    assert.equal(disables(named, "untagged"), 1, file)
  }
  const tagged = "export let held = 1 // eslint-disable-line no-restricted-syntax -- ZKM-1778\n"
  assert.deepEqual(await lintAt("src/probe.ts", tagged), [])
})

test("no disable hides a missing tag, not even a tagged disable of the tag rule", async () => {
  const code =
    "// eslint-disable-next-line local/tagged-disable -- ZKM-1778\n" +
    "// eslint-disable-next-line no-restricted-syntax\n" +
    "export let held = 1\n"
  assert.equal(disables(await lintAt("src/probe.ts", code), "untagged"), 1)
})

test("an inline config cannot turn the disable checks off", async () => {
  const code =
    '/* eslint "local/tagged-disable": "off" */\n' +
    "// eslint-disable-next-line no-restricted-syntax\n" +
    "export let held = 1\n"
  const messages = await lintAt("src/probe.ts", code)
  assert.equal(disables(messages, "untagged"), 1)
  assert.equal(disables(messages, "inline"), 1)
})

const touches = (messages) =>
  count(messages, "no-restricted-globals") + count(messages, "no-restricted-properties")
test("source outside platform storage, migrations and dev touches no browser storage", async () => {
  for (const code of [
    'localStorage.getItem("a")\n',
    "export const s = () => window.sessionStorage\n",
    "export const has = () => typeof indexedDB\n",
  ]) {
    assert.equal(touches(await lintAt("src/feature.ts", code)), 1, code)
    assert.equal(touches(await lintAt("src/storageMigrations/old.ts", `/** Storage migration: a. Remove when b. */\n${code}`)), 0, code)
  }
  const none = 'export const labels = { localStorage: "Sign-in" }\nexport const k = (d: any) => [d.sessionStorage(), "indexedDB"]\n'
  assert.equal(touches(await lintAt("src/feature.ts", none)), 0)
})

const HEADER = "local/storage-migration-header"
test("a storage migration opens with a comment that names it and when it goes", async () => {
  const file = "src/storageMigrations/transfers.ts"
  const stated = "/** Storage migration: the transfer rows. Remove when no device holds them. */"
  for (const code of [
    "export {}\n",
    "/** The transfer rows. */\n// Remove when x\nexport {}\n",
    `import { a } from "./a"\n${stated}\nexport { a }\n`,
    "/** Remove when x. */\nexport {}\n",
    "// Storage migration: the rows. Remove when gone.\nexport {}\n",
  ])
    assert.equal(count(await lintAt(file, code), HEADER), 1, code)
  for (const code of [
    `${stated}\nexport {}\n`,
    "/**\n * Storage migration: the transfer rows. Remove\n * when no device holds them.\n */\nexport {}\n",
    "\n/**\n * The transfer rows. Storage\n * migration: Remove when no device holds them.\n */\nexport {}\n",
  ])
    assert.equal(count(await lintAt(file, code), HEADER), 0, code)
  assert.equal(count(await lintAt("src/transfers.ts", "export {}\n"), HEADER), 0)
})

test("platform storage and the listed dev code may touch browser storage", async () => {
  const exempt = new ESLint({
    cwd: import.meta.dirname,
    overrideConfigFile: true,
    overrideConfig: migrated({
      tsconfigRootDir: import.meta.dirname,
      debt: true,
      react: ["src/probe.ts"],
      platformStorage: ["src/platform/storage/**"],
      browserStorage: ["src/dev/**/*.ts"],
    }),
  })
  const use = 'localStorage.getItem("a")\n'
  const at = async (file) => {
    const [result] = await exempt.lintText(use, { filePath: `${import.meta.dirname}/${file}` })
    return touches(result.messages)
  }
  assert.equal(await at("src/platform/storage/tabStash.ts"), 0)
  assert.equal(await at("src/dev/configDraft.ts"), 0)
  assert.equal(await at("src/features/foo.ts"), 1)
})

const TIMER = "local/timer-in-view"
test("a view or a file that defines a hook starts no timer or pace poll", async () => {
  for (const [file, code] of [
    ["src/View.tsx", "export const View = () => { setTimeout(() => {}, 1); return null }\n"],
    ["src/View.tsx", "export const View = () => { window.setInterval(() => {}, 1); return null }\n"],
    ["src/useTick.ts", "export const useTick = (pace: any) => pace.every(1, () => {})\n"],
    ["src/ticks.ts", "export function useTick(s: any) {\n  return s.pace.after(1, () => {})\n}\n"],
    ["scripts/fixture.tsx", "export const F = (p: any) => { p.pace.wait(1); return null }\n"],
  ])
    assert.equal(count(await lintAt(file, code), TIMER), 1, `${file}: ${code}`)
})

test("a helper under ui/ or in a component's folder starts no timer", async () => {
  const code = "export const later = () => setTimeout(() => {}, 1)\n"
  for (const file of ["src/ui/afterEvent.ts", "src/ui/flow/plan.ts", "src/features/Sheet/flow.ts"])
    assert.equal(count(await lintAt(file, code), TIMER), 1, file)
})

test("engine code, a test and another object's every are no view timer", async () => {
  for (const [file, code] of [
    ["src/ticks.ts", "export const tick = (pace: any) => pace.every(1, () => {})\n"],
    ["src/ticks.ts", "export const later = () => setTimeout(() => {}, 1)\n"],
    ["src/View.tsx", "export const View = (xs: any) => { xs.every(Boolean); return null }\n"],
    ["test/view.test.tsx", "setTimeout(() => {}, 1)\n"],
    ["src/View.test.tsx", "setTimeout(() => {}, 1)\n"],
    ["src/features/Sheet/sheetFlow.ts", "export const later = () => setTimeout(() => {}, 1)\n"],
    ["src/features/Sheet/sheetTransition.ts", "export const later = () => setTimeout(() => {}, 1)\n"],
  ])
    assert.equal(count(await lintAt(file, code), TIMER), 0, `${file}: ${code}`)
})

const MESSAGE = "local/message-in-state"
test("a view reads no error's message into state or onto the screen", async () => {
  for (const code of [
    "export const f = (set: any) => { try { set(1) } catch (x) { set((x as any).message) } }\n",
    "export const f = (p: Promise<void>, set: any) => p.catch((failure) => set(failure.message))\n",
    "export const f = (p: Promise<void>, set: any) => p.then(() => {}, (r) => set(r.message))\n",
    "export const f = (c: unknown, set: any) => set((c as Error).message)\n",
    "class PublishError extends Error {}\nexport const f = (set: any) => set(new PublishError().message)\n",
    "export const f = (x: unknown) => <p>{x instanceof Error ? x.message : null}</p>\n",
    "export const V = (error: Error) => <p>{error.message}</p>\n",
    "export const V = (props: any) => <p title={props.error.message} />\n",
  ])
    assert.equal(count(await lintAt("src/View.tsx", code), MESSAGE), 1, code)
  const hook = "export const useError = (err: Error, set: any) => set(err.message)\n"
  assert.equal(count(await lintAt("src/useError.ts", hook), MESSAGE), 1, hook)
})

test("copy fields, a returned message, a write, a check and engine code are no error message in a view", async () => {
  for (const [file, code] of [
    ["src/View.tsx", "export const V = (notice: any) => <p>{notice.message}</p>\n"],
    ["src/View.tsx", "export function f(e: Error) {\n  return e.message\n}\n"],
    ["src/View.tsx", "export const f = (e: Error) => {\n  e.message = 'x'\n}\n"],
    ["src/View.tsx", "export const f = (e: Error) => e.message.includes('x')\n"],
    ["src/failure.ts", "export const f = (e: Error, set: any) => set(e.message)\n"],
    ["test/view.test.tsx", "export const f = (e: Error, set: any) => set(e.message)\n"],
  ])
    assert.equal(count(await lintAt(file, code), MESSAGE), 0, `${file}: ${code}`)
})

// A wallet package's path inside the test's own directory, as lint sees a file on disk.
const WALLET = "src/repo/packages/web-wallet/src"
test("a wallet source file's legacy channel is debt, reported at its first use", async () => {
  const code = 'export const a = 1\nwalletStorage.getItem("k")\nwalletStorage.setItem("k", "v")\n'
  const [result] = await eslint.lintText(code, { filePath: `${import.meta.dirname}/${WALLET}/features/x/store.ts` })
  const found = by(result.messages, "local/legacy-store")
  assert.deepEqual(
    found.map((m) => [m.line, m.message.includes("walletStorage")]),
    [[2, true]],
  )
  const tagged = `// eslint-disable-next-line local/legacy-store -- ZKM-1625\n${code.split("\n").slice(1).join("\n")}`
  assert.deepEqual(await lintAt(`${WALLET}/features/x/store.ts`, tagged), [])
})

test("storage migrations, channel implementations and other packages hold no legacy store", async () => {
  const code = 'walletStorage.getItem("k")\n'
  for (const file of [
    `${WALLET}/platform/storage/storageMigrations/old.ts`,
    `${WALLET}/platform/storage/walletStorage.ts`,
    "src/repo/packages/sdk/src/store.ts",
  ])
    assert.equal(count(await lintAt(file, code), "local/legacy-store"), 0, file)
})


test("page-time code reads no Date.now: no call, default or fallback; other code may", async () => {
  const timed = new ESLint({
    cwd: import.meta.dirname,
    overrideConfigFile: true,
    overrideConfig: migrated({
      tsconfigRootDir: import.meta.dirname,
      debt: true,
      react: ["src/probe.ts"],
      pageTime: ["src/engine/**"],
    }),
  })
  const clock = async (file, code) => {
    const [result] = await timed.lintText(code, { filePath: `${import.meta.dirname}/${file}` })
    return count(result.messages, "local/wall-clock")
  }
  for (const code of [
    "export const at = () => Date.now()\n",
    "export const make = (now = Date.now) => now\n",
    "export const read = (now?: () => number) => (now ?? Date.now)()\n",
  ])
    assert.equal(await clock("src/engine/store.ts", code), 1, code)
  assert.equal(await clock("src/engine/store.ts", "export const at = (now: () => number) => now()\n"), 0)
  assert.equal(await clock("src/app/page.ts", "export const now = Date.now\n"), 0)
})
