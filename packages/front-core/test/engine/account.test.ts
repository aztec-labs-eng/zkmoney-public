// @vitest-environment node
import { CompleteAddress } from "@aztec-labs/stdlib/contract"
import { beforeEach, describe, expect, it, vi } from "vitest"
import {
  AUTH_TYPE,
  type ContractService,
  type ObsidionAccount,
  type ObsidionWallet,
} from "@obsidion/sdk"
import { accountResource, createAccountRecord } from "../../src/engine/account"
import { openDatabase } from "../../src/engine/database"
import { memoryBackend } from "../../src/engine/memoryBackend"
import { fixed, valueOf } from "../../src/engine/resource"
import type { AccountState } from "../../src/types"
import { fakeClock, flush, later } from "./taskTable"

const STORED = "0x" + "11".repeat(288)
const PARSED = {} as CompleteAddress

const built = {} as ObsidionAccount

function setup(o: { stored?: Partial<AccountState> | null; key?: boolean } = {}) {
  const stored =
    o.stored === null ? undefined : ({ completeAddress: STORED, ...o.stored } as AccountState)
  const accounts = { get: vi.fn(async () => stored) }
  let key = o.key ?? true
  const service = {
    getAuthProvider: vi.fn(async () => ({})),
    getSecretKey: vi.fn(async () => (key ? { secret: true } : undefined)),
  }
  const wallet = { getObsidionAccountWallet: vi.fn(async () => built) }
  return {
    accounts,
    service,
    wallet,
    cacheKey: () => (key = true),
    deps: {
      accounts,
      auth: () => service as never,
      contractService: fixed("contractService", {} as ContractService),
    },
  }
}

describe("accountResource", () => {
  fakeClock()
  beforeEach(() => void vi.spyOn(CompleteAddress, "fromString").mockResolvedValue(PARSED))

  it("unlocks once a late wallet arrives", async () => {
    const { wallet, deps } = setup()
    const late = later<ObsidionWallet>("wallet")
    const account = accountResource({ ...deps, wallet: late.resource })
    await flush()
    expect(account.get().status).toBe("pending")
    late.ready(wallet as unknown as ObsidionWallet)
    await flush()
    expect(valueOf(account)).toBe(built)
  })

  it("unlocks once the contract service arrives after the wallet, with no retry", async () => {
    const { wallet, deps } = setup()
    const late = later<ContractService>("contractService")
    const account = accountResource({
      ...deps,
      wallet: fixed("wallet", wallet as never),
      contractService: late.resource,
    })
    await flush()
    expect(account.get().status).toBe("pending")
    expect(wallet.getObsidionAccountWallet).not.toHaveBeenCalled()
    late.ready({} as ContractService)
    await flush()
    expect(valueOf(account)).toBe(built)
  })

  it("stays pending with no stored account", async () => {
    const { wallet, deps } = setup({ stored: null })
    const account = accountResource({ ...deps, wallet: fixed("wallet", wallet as never) })
    await flush()
    expect(account.get().status).toBe("pending")
    expect(wallet.getObsidionAccountWallet).not.toHaveBeenCalled()
  })

  it("waits for a retry when no key is cached, then unlocks", async () => {
    const { wallet, deps, cacheKey } = setup({ key: false })
    const account = accountResource({ ...deps, wallet: fixed("wallet", wallet as never) })
    await flush()
    expect(account.get()).toMatchObject({
      status: "failed",
      error: expect.objectContaining({ code: "account.unlockFailed" }),
    })
    cacheKey()
    await vi.advanceTimersByTimeAsync(300_000)
    expect(account.get().status).toBe("failed")
    account.retry()
    await flush()
    expect(valueOf(account)).toBe(built)
  })

  it("unlocks the stored address", async () => {
    const { wallet, deps } = setup()
    accountResource({ ...deps, wallet: fixed("wallet", wallet as never) })
    await flush()
    expect(CompleteAddress.fromString).toHaveBeenCalledWith(STORED)
    expect(wallet.getObsidionAccountWallet).toHaveBeenCalledWith(
      expect.anything(),
      {},
      { completeAddress: PARSED, register: true },
    )
  })

  it("returns a sign-in's account as is, and installs a later one in place", async () => {
    const { wallet, deps } = setup()
    const handed = {} as ObsidionAccount
    const account = accountResource({
      ...deps,
      wallet: fixed("wallet", wallet as never),
      handoff: handed,
    })
    await flush()
    expect(valueOf(account)).toBe(handed)
    expect(wallet.getObsidionAccountWallet).not.toHaveBeenCalled()
    const next = {} as ObsidionAccount
    const seen: string[] = []
    account.subscribe(() => seen.push(account.get().status))
    account.handOff(next)
    expect(valueOf(account)).toBe(next)
    expect(seen).toEqual(["ready"])
  })
})

describe("createAccountRecord", () => {
  const LEGACY = {
    name: "Account 1",
    completeAddress: "0xacct",
    signKeyConfig: { type: AUTH_TYPE.WEB_AUTHN, webauthnData: { credentialId: "c", pubkey: "p" } },
  }
  const open = (entries: Record<string, string>) =>
    createAccountRecord({ db: openDatabase(memoryBackend(new Map(Object.entries(entries)))) })

  it.each([
    ["carries the blob without its name", { obsidion_accounts: JSON.stringify(LEGACY) }, false],
    [
      "stamps an older build's entry mark",
      { "obsidion_accounts": JSON.stringify(LEGACY), "onboarding.walletEntered:0xabc": "1" },
      true,
    ],
  ])("%s", async (_, entries, entered) => {
    const carried = { completeAddress: LEGACY.completeAddress, signKeyConfig: LEGACY.signKeyConfig }
    expect(await open(entries).get()).toEqual(entered ? { ...carried, enteredAt: 0 } : carried)
  })

  it.each(['{"completeAddress":1}', "not json"])(
    "fails the open over an invalid blob %s, and keeps its bytes",
    async (blob) => {
      const backend = memoryBackend(new Map([["obsidion_accounts", blob]]))
      const record = createAccountRecord({ db: openDatabase(backend) })
      await expect(record.get()).rejects.toThrow()
      expect(record.view.get()).toMatchObject({ value: undefined, failed: true })
      expect(backend.entries.get("obsidion_accounts")).toBe(blob)
    },
  )

  it("lets a sign-in replace an unreadable blob, which this record and the next open read", async () => {
    const blob = "not json"
    const backend = memoryBackend(new Map([["obsidion_accounts", blob]]))
    const saved = { completeAddress: "0xv5", signKeyConfig: LEGACY.signKeyConfig } as AccountState
    const record = createAccountRecord({ db: openDatabase(backend) })
    const seen: unknown[] = []
    record.view.subscribe(() => seen.push(record.view.get().value))
    await expect(record.get()).rejects.toThrow()
    await record.save(saved)
    expect(await record.get()).toEqual(saved)
    await new Promise((r) => setTimeout(r))
    expect(record.view.get()).toMatchObject({ value: saved, loaded: true, failed: false })
    expect(seen.at(-1)).toEqual(saved)
    expect(await record.firstEntry()).toBe(true)
    expect(await createAccountRecord({ db: openDatabase(backend) }).get()).toMatchObject(saved)
    expect(backend.entries.get("obsidion_accounts")).toBe(blob)
  })

  it("never replaces a newer build's account it cannot open", async () => {
    const entries = new Map([
      ["acct/meta/account", "2"],
      ["acct/account/current", "{}"],
    ])
    const record = createAccountRecord({ db: openDatabase(memoryBackend(entries)) })
    await expect(record.save({ completeAddress: "0xv5" } as AccountState)).rejects.toThrow()
    expect(entries.get("acct/account/current")).toBe("{}")
  })

  it("keeps the entry mark when a recovery saves the account again", async () => {
    const record = open({ obsidion_accounts: JSON.stringify(LEGACY) })
    expect(await record.firstEntry()).toBe(true)
    await record.save({ completeAddress: "0xv5", signKeyConfig: LEGACY.signKeyConfig })
    expect((await record.get())?.enteredAt).toEqual(expect.any(Number))
    expect(await record.firstEntry()).toBe(false)
  })

  it("marks the first of two overlapping entries only", async () => {
    const record = open({ obsidion_accounts: JSON.stringify(LEGACY) })
    expect(await Promise.all([record.firstEntry(), record.firstEntry()])).toEqual([true, false])
    expect(await record.firstEntry()).toBe(false)
  })
})
