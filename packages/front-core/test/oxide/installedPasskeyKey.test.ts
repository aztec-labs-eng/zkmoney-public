import { describe, expect, it, vi } from "vitest"
import { Fr } from "@aztec-labs/aztec.js/fields"
import type { Address, Hex } from "viem"
import { predictAccountAddressLocally, type AuthKeyEntry } from "@oxide/l1-contracts"

import { deriveBootstrapKey } from "../../src/oxide/oxideAccountKeys"
import { readInstalledPasskeyKey } from "../../src/oxide/installedPasskeyKey"
import { MAX_PASSKEY_CANDIDATES } from "../../src/oxide/passkeyCredentialByTag"

const FACTORY = "0x00000000000000000000000000000000000000f1" as Address
const OTHER_FACTORY = "0x00000000000000000000000000000000000000f8" as Address
const REGISTRY = "0x00000000000000000000000000000000000000f2" as Address
const REAL = `${"ab".repeat(32)}${"cd".repeat(32)}`
const OTHER = `${"1f".repeat(32)}${"3e".repeat(32)}`
const UNRELATED = `${"99".repeat(32)}${"88".repeat(32)}`
const BACKUP = `${"5a".repeat(32)}${"a5".repeat(32)}`
const CREDENTIAL_METADATA = `0x${"07".repeat(16)}` as Hex
const ZERO_HASH = `0x${"00".repeat(32)}` as Hex
const NAME_HASH = `0x${"ab".repeat(32)}` as Hex

const first = Fr.random()
const second = Fr.random()
/** The account `msk` gets under `factory`, as the read predicts it. */
const accountOf = (msk: Fr, factory: Address = FACTORY) =>
  predictAccountAddressLocally(factory, deriveBootstrapKey(msk).address)

function entry(pubkeyHex: string, metadata: Hex = CREDENTIAL_METADATA): AuthKeyEntry {
  return {
    key: { qx: `0x${pubkeyHex.slice(0, 64)}` as Hex, qy: `0x${pubkeyHex.slice(64)}` as Hex },
    metadata,
  }
}

type Account = { name?: Hex; code?: Hex; keys?: readonly AuthKeyEntry[]; authKeyCount?: number }
type Chain = Record<Address, Account>

/** A reader over `chain`, keyed by each account's predicted address. */
function readerOver(chain: Chain) {
  const readNameOf = vi.fn(
    async (_registry: Address, account: Address) => chain[account]?.name ?? ZERO_HASH,
  )
  const getCode = vi.fn(async (account: Address) => chain[account]?.code)
  const readAuthKeysCounted = vi.fn(async (account: Address, max: number) => {
    const keys = chain[account]?.keys ?? []
    return {
      entries: keys.slice(0, max),
      authKeyCount: chain[account]?.authKeyCount ?? keys.length,
    }
  })
  return { readNameOf, getCode, readAuthKeysCounted }
}

/** A registered account: named, deployed, holding `keys`. */
const deployed = (...keys: AuthKeyEntry[]): Account => ({
  name: NAME_HASH,
  code: "0x6080" as Hex,
  keys,
})

const read = (
  reader: ReturnType<typeof readerOver>,
  masterKeys: Fr[] = [first, second],
  factories: Address[] = [FACTORY],
  stop?: AbortSignal,
) =>
  readInstalledPasskeyKey(masterKeys, [REAL, OTHER], {
    reader,
    registry: REGISTRY,
    accountFactories: factories,
    ...(stop ? { stop } : {}),
  })

describe("readInstalledPasskeyKey", () => {
  it("returns the possible key the first candidate's account installed, with its set", async () => {
    const reader = readerOver({ [accountOf(first)]: deployed(entry(REAL)) })
    expect(await read(reader)).toEqual({ kind: "found", pubkeyHex: REAL, passkeys: [REAL] })
    expect(reader.readNameOf).toHaveBeenCalledWith(REGISTRY, accountOf(first))
    expect(reader.readNameOf).toHaveBeenCalledWith(REGISTRY, accountOf(second))
    expect(reader.readAuthKeysCounted).toHaveBeenCalledTimes(1)
    expect(reader.readAuthKeysCounted).toHaveBeenCalledWith(
      accountOf(first),
      MAX_PASSKEY_CANDIDATES,
    )
  })

  it("a two-key account answers the matched key beside every key, in L1 order", async () => {
    const reader = readerOver({
      [accountOf(first)]: deployed(entry(REAL), entry(BACKUP, `0x01${"ee".repeat(94)}`)),
    })
    expect(await read(reader)).toEqual({
      kind: "found",
      pubkeyHex: REAL,
      passkeys: [REAL, BACKUP],
    })
    const reversed = readerOver({ [accountOf(first)]: deployed(entry(BACKUP), entry(REAL)) })
    expect(await read(reversed)).toEqual({
      kind: "found",
      pubkeyHex: REAL,
      passkeys: [BACKUP, REAL],
    })
  })

  it("matches the second possible key, given with 0x and upper case, and returns it normalised", async () => {
    const reader = readerOver({ [accountOf(second)]: deployed(entry(OTHER)) })
    const shouted = `0x${OTHER.toUpperCase()}`
    expect(shouted.slice(2)).not.toBe(OTHER)
    const outcome = await readInstalledPasskeyKey([first, second], [REAL, shouted], {
      reader,
      registry: REGISTRY,
      accountFactories: [FACTORY],
    })
    expect(outcome).toEqual({ kind: "found", pubkeyHex: OTHER, passkeys: [OTHER] })
  })

  it("reads one account when only one master key is present", async () => {
    const reader = readerOver({ [accountOf(first)]: deployed(entry(REAL)) })
    expect(await read(reader, [first])).toMatchObject({ kind: "found", pubkeyHex: REAL })
    expect(reader.readNameOf).toHaveBeenCalledTimes(1)
  })

  it("spans every catalog factory and stays one answer when both hold the same key and set", async () => {
    const reader = readerOver({
      [accountOf(first)]: deployed(entry(REAL)),
      [accountOf(first, OTHER_FACTORY)]: deployed(entry(REAL)),
    })
    expect(await read(reader, [first], [FACTORY, OTHER_FACTORY])).toEqual({
      kind: "found",
      pubkeyHex: REAL,
      passkeys: [REAL],
    })
    expect(reader.readNameOf).toHaveBeenCalledTimes(2)
    expect(reader.readAuthKeysCounted).toHaveBeenCalledTimes(2)
  })

  it("an account the registry does not name contributes nothing, and is never read", async () => {
    // Anyone can put code at a predicted address; only a name from the registry makes it the user's.
    const reader = readerOver({ [accountOf(first)]: { code: "0x6080", keys: [entry(REAL)] } })
    expect(await read(reader)).toEqual({ kind: "none" })
    expect(reader.getCode).not.toHaveBeenCalled()
    expect(reader.readAuthKeysCounted).not.toHaveBeenCalled()
  })

  it("no code on a named account: none, and no key read", async () => {
    const reader = readerOver({ [accountOf(first)]: { name: NAME_HASH, code: "0x" } })
    expect(await read(reader)).toEqual({ kind: "none" })
    expect(reader.readAuthKeysCounted).not.toHaveBeenCalled()
  })

  it("a deployed account with no keys, or none matching: none", async () => {
    const empty = readerOver({ [accountOf(first)]: deployed() })
    expect(await read(empty)).toEqual({ kind: "none" })
    const unrelated = readerOver({ [accountOf(first)]: deployed(entry(UNRELATED)) })
    expect(await read(unrelated)).toEqual({ kind: "none" })
  })

  it("finds the match among several installed keys", async () => {
    const reader = readerOver({
      [accountOf(first)]: deployed(entry(UNRELATED), entry(REAL)),
    })
    expect(await read(reader)).toEqual({
      kind: "found",
      pubkeyHex: REAL,
      passkeys: [UNRELATED, REAL],
    })
  })

  it("both possible keys found, on one account or across two: ambiguous", async () => {
    const oneAccount = readerOver({ [accountOf(first)]: deployed(entry(REAL), entry(OTHER)) })
    expect(await read(oneAccount)).toEqual({ kind: "ambiguous" })
    const twoAccounts = readerOver({
      [accountOf(first)]: deployed(entry(REAL)),
      [accountOf(second)]: deployed(entry(OTHER)),
    })
    expect(await read(twoAccounts)).toEqual({ kind: "ambiguous" })
  })

  it("two accounts holding the key with different sets: ambiguous", async () => {
    const reader = readerOver({
      [accountOf(first)]: deployed(entry(REAL)),
      [accountOf(second)]: deployed(entry(REAL), entry(BACKUP)),
    })
    expect(await read(reader)).toEqual({ kind: "ambiguous" })
  })

  it("a key the account lists twice is one member of the set, and one answer", async () => {
    const reader = readerOver({
      [accountOf(first)]: deployed(entry(REAL), entry(REAL), entry(UNRELATED)),
    })
    expect(await read(reader)).toEqual({
      kind: "found",
      pubkeyHex: REAL,
      passkeys: [REAL, UNRELATED],
    })
  })

  it("the same key and set on both accounts is one answer", async () => {
    const reader = readerOver({
      [accountOf(first)]: deployed(entry(REAL)),
      [accountOf(second)]: deployed(entry(REAL)),
    })
    expect(await read(reader)).toEqual({ kind: "found", pubkeyHex: REAL, passkeys: [REAL] })
  })

  it("a holding account with more keys than were read, or a malformed key: incomplete", async () => {
    const nine = readerOver({
      [accountOf(first)]: { ...deployed(entry(REAL)), authKeyCount: MAX_PASSKEY_CANDIDATES + 1 },
    })
    expect(await read(nine)).toEqual({ kind: "incomplete" })
    const short = {
      key: { qx: `0x${"ab".repeat(32)}` as Hex, qy: "0xcd" as Hex },
      metadata: CREDENTIAL_METADATA,
    }
    const malformed = readerOver({ [accountOf(first)]: deployed(entry(REAL), short) })
    expect(await read(malformed)).toEqual({ kind: "incomplete" })
    // An account that holds no possible key is not judged at all.
    const elsewhere = readerOver({
      [accountOf(first)]: deployed(entry(REAL)),
      [accountOf(second)]: { ...deployed(entry(UNRELATED)), authKeyCount: 20 },
    })
    expect(await read(elsewhere)).toEqual({ kind: "found", pubkeyHex: REAL, passkeys: [REAL] })
  })

  it("ignores the credential-id metadata", async () => {
    for (const metadata of ["0x", "0x07", "0xzz"] as Hex[]) {
      const reader = readerOver({ [accountOf(first)]: deployed(entry(REAL, metadata)) })
      expect(await read(reader)).toMatchObject({ kind: "found", pubkeyHex: REAL })
    }
  })

  it("inspects only the first entries when the reader returns more than it was asked for", async () => {
    const filler = Array.from({ length: MAX_PASSKEY_CANDIDATES }, () => entry(UNRELATED))
    const reader = readerOver({ [accountOf(first)]: deployed(...filler, entry(REAL)) })
    reader.readAuthKeysCounted.mockImplementation(async () => ({
      entries: [...filler, entry(REAL)],
      authKeyCount: filler.length + 1,
    }))
    expect(await read(reader)).toEqual({ kind: "none" })
  })

  it("a stopped read starts no further step", async () => {
    const chain = { [accountOf(first)]: deployed(entry(REAL)) }

    const before = readerOver(chain)
    const stoppedBefore = new AbortController()
    stoppedBefore.abort()
    await expect(read(before, [first], [FACTORY], stoppedBefore.signal)).rejects.toThrow()
    expect(before.readNameOf).not.toHaveBeenCalled()

    const afterName = readerOver(chain)
    const stopAtName = new AbortController()
    afterName.readNameOf.mockImplementation(async () => {
      stopAtName.abort()
      return NAME_HASH
    })
    await expect(read(afterName, [first], [FACTORY], stopAtName.signal)).rejects.toThrow()
    expect(afterName.getCode).not.toHaveBeenCalled()

    const afterCode = readerOver(chain)
    const stopAtCode = new AbortController()
    afterCode.getCode.mockImplementation(async () => {
      stopAtCode.abort()
      return "0x6080" as Hex
    })
    await expect(read(afterCode, [first], [FACTORY], stopAtCode.signal)).rejects.toThrow()
    expect(afterCode.readAuthKeysCounted).not.toHaveBeenCalled()
  })

  it("a sibling still being named when the other fails starts nothing once stopped", async () => {
    const reader = readerOver({ [accountOf(second)]: deployed(entry(REAL)) })
    const stop = new AbortController()
    let releaseSecond!: () => void
    reader.readNameOf.mockImplementation(async (_registry, account) => {
      if (account === accountOf(second)) {
        await new Promise<void>((resolve) => (releaseSecond = resolve))
      }
      return NAME_HASH
    })
    reader.getCode.mockImplementation(async (account) => {
      if (account === accountOf(first)) throw new Error("RPC down")
      return "0x6080" as Hex
    })
    await expect(read(reader, [first, second], [FACTORY], stop.signal)).rejects.toThrow(/RPC down/)
    stop.abort()
    releaseSecond()
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(reader.getCode).toHaveBeenCalledTimes(1)
    expect(reader.readAuthKeysCounted).not.toHaveBeenCalled()
  })

  it("any failed read rejects", async () => {
    const chain = { [accountOf(first)]: deployed(entry(REAL)) }
    for (const failing of ["readNameOf", "getCode", "readAuthKeysCounted"] as const) {
      const reader = readerOver(chain)
      reader[failing].mockRejectedValue(new Error("RPC down"))
      await expect(read(reader)).rejects.toThrow(/RPC down/)
    }
  })
})
