// @vitest-environment node
/**
 * Device state's load carries the preferences older builds kept in `localStorage` into the
 * database once, in its own write, and never touches the `localStorage` copies.
 */
import { memoryBackend, openDatabase } from "@obsidion/front-core"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { deviceState, writeDeviceKeys } from "../../../src/platform/storage/deviceKeys"

let local: Map<string, string>
beforeEach(() => {
  local = new Map()
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => local.get(key) ?? null,
    setItem: (key: string, value: string) => void local.set(key, value),
    removeItem: (key: string) => void local.delete(key),
  })
})
afterEach(() => vi.unstubAllGlobals())

async function load(saved: [string, string][] = [], durable = true) {
  const backend = memoryBackend()
  await backend.apply(saved)
  const db = openDatabase(backend)
  const device = deviceState(db, () => durable)
  await device.load()
  return { backend, db, device }
}

describe("the preferences older builds kept in localStorage", () => {
  it("carries a key the database lacks, and leaves the localStorage copy", async () => {
    local.set("webwallet.hide-balances", "true")
    local.set("webwallet.ticket-intro-seen", "1")
    const { backend, device } = await load()
    expect(device.get()).toMatchObject({ hideBalances: true, ticketIntroSeen: true })
    expect(backend.entries.get("webwallet.hide-balances")).toBe("true")
    expect(local.get("webwallet.hide-balances")).toBe("true")
  })

  it("leaves a key the database holds as the database has it", async () => {
    local.set("webwallet.hide-balances", "true")
    local.set("webwallet.local-refusals", "3")
    const { backend, device } = await load([
      ["webwallet.hide-balances", "false"],
      ["webwallet.local-refusals", "0"],
    ])
    expect(device.get()).toMatchObject({ hideBalances: false, localRefusals: 0 })
    expect(backend.entries.get("webwallet.hide-balances")).toBe("false")
  })

  it("carries no value it cannot read, and keeps the bytes of both copies", async () => {
    local.set("webwallet.passkey-names", "{unclosed")
    const { backend, device } = await load([["webwallet.local-passkey-hint-shown", "many"]])
    expect(device.get()).toMatchObject({ passkeyNames: {}, localPasskeyHintShown: 0 })
    expect(backend.entries.has("webwallet.passkey-names")).toBe(false)
    expect(backend.entries.get("webwallet.local-passkey-hint-shown")).toBe("many")
    expect(local.get("webwallet.passkey-names")).toBe("{unclosed")
  })

  it("leaves the localStorage copy under a database in memory, which carries it on each page", async () => {
    local.set("webwallet.hide-paylink-info", "true")
    const first = await load([], false)
    await writeDeviceKeys(first.db, { hidePaylinkInfo: "false" })
    expect(first.device.get().hidePaylinkInfo).toBe(false)
    expect(local.get("webwallet.hide-paylink-info")).toBe("true")
    const next = await load([], false)
    expect(next.device.get().hidePaylinkInfo).toBe(true)
  })

  it("reads nothing where localStorage throws", async () => {
    vi.stubGlobal("localStorage", {
      getItem: () => {
        throw new DOMException("denied", "SecurityError")
      },
    })
    const { backend, device } = await load()
    expect(device.get()).toMatchObject({ loaded: true, hideBalances: false })
    expect(backend.entries.size).toBe(0)
  })
})
