import { describe, expect, it, vi } from "vitest"
import { Fr } from "@aztec/aztec.js/fields"
import type { Address, Hex } from "viem"
import type { AuthKeyEntry } from "@oxide/l1-contracts"

import { deriveBootstrapKey } from "../../src/oxide/oxideAccountKeys"
import { readInstalledPasskeyKey } from "../../src/oxide/installedPasskeyKey"
import { MAX_PASSKEY_CANDIDATES } from "../../src/oxide/passkeyCredentialByTag"

const FACTORY = "0x00000000000000000000000000000000000000f1" as Address
const REAL = `${"ab".repeat(32)}${"cd".repeat(32)}`
const OTHER = `${"1f".repeat(32)}${"3e".repeat(32)}`
const UNRELATED = `${"99".repeat(32)}${"88".repeat(32)}`
const CREDENTIAL_METADATA = `0x${"07".repeat(16)}` as Hex

const first = Fr.random()
const second = Fr.random()
const accountOf = (msk: Fr) => `0x${deriveBootstrapKey(msk).address.slice(-40)}` as Address

function entry(pubkeyHex: string, metadata: Hex = CREDENTIAL_METADATA): AuthKeyEntry {
  return {
    key: { qx: `0x${pubkeyHex.slice(0, 64)}` as Hex, qy: `0x${pubkeyHex.slice(64)}` as Hex },
    metadata,
  }
}

type Chain = Record<Address, { code?: Hex; keys?: readonly AuthKeyEntry[] }>

/** A reader over `chain`, keyed by each account's predicted address (here: its bootstrap address). */
function readerOver(chain: Chain) {
  const predictAccountAddress = vi.fn(
    async (_factory: Address, bootstrap: Address) => `0x${bootstrap.slice(-40)}` as Address,
  )
  const getCode = vi.fn(async (account: Address) => chain[account]?.code)
  const readAuthKeys = vi.fn(async (account: Address, _max: number) => chain[account]?.keys ?? [])
  return { predictAccountAddress, getCode, readAuthKeys }
}

const deployed = (...keys: AuthKeyEntry[]) => ({ code: "0x6080" as Hex, keys })

describe("readInstalledPasskeyKey", () => {
  it("returns the possible key the first candidate's account installed", async () => {
    const reader = readerOver({ [accountOf(first)]: deployed(entry(REAL)) })
    const key = await readInstalledPasskeyKey([first, second], [REAL, OTHER], {
      reader,
      accountFactories: [FACTORY],
    })
    expect(key).toBe(REAL)
    expect(reader.predictAccountAddress).toHaveBeenCalledWith(
      FACTORY,
      deriveBootstrapKey(first).address,
    )
    expect(reader.predictAccountAddress).toHaveBeenCalledWith(
      FACTORY,
      deriveBootstrapKey(second).address,
    )
    expect(reader.readAuthKeys).toHaveBeenCalledTimes(1)
    expect(reader.readAuthKeys).toHaveBeenCalledWith(accountOf(first), MAX_PASSKEY_CANDIDATES)
  })

  it("matches the second possible key, given with 0x and upper case, and returns it normalised", async () => {
    const reader = readerOver({ [accountOf(second)]: deployed(entry(OTHER)) })
    const shouted = `0x${OTHER.toUpperCase()}`
    expect(shouted.slice(2)).not.toBe(OTHER)
    const key = await readInstalledPasskeyKey([first, second], [REAL, shouted], {
      reader,
      accountFactories: [FACTORY],
    })
    expect(key).toBe(OTHER)
  })

  it("reads one account when only one master key is present", async () => {
    const reader = readerOver({ [accountOf(first)]: deployed(entry(REAL)) })
    expect(
      await readInstalledPasskeyKey([first], [REAL, OTHER], {
        reader,
        accountFactories: [FACTORY],
      }),
    ).toBe(REAL)
    expect(reader.predictAccountAddress).toHaveBeenCalledTimes(1)
  })

  it("spans every catalog factory and stays one answer when both hold the same key", async () => {
    const OTHER_FACTORY = "0x00000000000000000000000000000000000000f8" as const
    const reader = readerOver({
      [accountOf(first)]: deployed(entry(REAL)),
    })
    expect(
      await readInstalledPasskeyKey([first], [REAL, OTHER], {
        reader,
        accountFactories: [FACTORY, OTHER_FACTORY],
      }),
    ).toBe(REAL)
    expect(reader.predictAccountAddress).toHaveBeenCalledTimes(2)
  })

  it("no code on either account: nothing, and no key read", async () => {
    const reader = readerOver({ [accountOf(first)]: { code: "0x" } })
    expect(
      await readInstalledPasskeyKey([first, second], [REAL, OTHER], {
        reader,
        accountFactories: [FACTORY],
      }),
    ).toBeUndefined()
    expect(reader.readAuthKeys).not.toHaveBeenCalled()
  })

  it("a deployed account with no keys, or none matching: nothing", async () => {
    const empty = readerOver({ [accountOf(first)]: deployed() })
    expect(
      await readInstalledPasskeyKey([first, second], [REAL, OTHER], {
        reader: empty,
        accountFactories: [FACTORY],
      }),
    ).toBeUndefined()
    const unrelated = readerOver({ [accountOf(first)]: deployed(entry(UNRELATED)) })
    expect(
      await readInstalledPasskeyKey([first, second], [REAL, OTHER], {
        reader: unrelated,
        accountFactories: [FACTORY],
      }),
    ).toBeUndefined()
  })

  it("finds the match among several installed keys", async () => {
    const reader = readerOver({
      [accountOf(first)]: deployed(entry(UNRELATED), entry(REAL)),
    })
    expect(
      await readInstalledPasskeyKey([first, second], [REAL, OTHER], {
        reader,
        accountFactories: [FACTORY],
      }),
    ).toBe(REAL)
  })

  it("both possible keys found, on one account or across two: nothing", async () => {
    const oneAccount = readerOver({ [accountOf(first)]: deployed(entry(REAL), entry(OTHER)) })
    expect(
      await readInstalledPasskeyKey([first, second], [REAL, OTHER], {
        reader: oneAccount,
        accountFactories: [FACTORY],
      }),
    ).toBeUndefined()
    const twoAccounts = readerOver({
      [accountOf(first)]: deployed(entry(REAL)),
      [accountOf(second)]: deployed(entry(OTHER)),
    })
    expect(
      await readInstalledPasskeyKey([first, second], [REAL, OTHER], {
        reader: twoAccounts,
        accountFactories: [FACTORY],
      }),
    ).toBeUndefined()
  })

  it("the same key on both accounts is one key", async () => {
    const reader = readerOver({
      [accountOf(first)]: deployed(entry(REAL)),
      [accountOf(second)]: deployed(entry(REAL)),
    })
    expect(
      await readInstalledPasskeyKey([first, second], [REAL, OTHER], {
        reader,
        accountFactories: [FACTORY],
      }),
    ).toBe(REAL)
  })

  it("ignores the credential-id metadata", async () => {
    for (const metadata of ["0x", "0x07", "0xzz"] as Hex[]) {
      const reader = readerOver({ [accountOf(first)]: deployed(entry(REAL, metadata)) })
      expect(
        await readInstalledPasskeyKey([first, second], [REAL, OTHER], {
          reader,
          accountFactories: [FACTORY],
        }),
      ).toBe(REAL)
    }
  })

  it("inspects only the first entries when the reader returns more than it was asked for", async () => {
    const filler = Array.from({ length: MAX_PASSKEY_CANDIDATES }, () => entry(UNRELATED))
    const reader = readerOver({ [accountOf(first)]: deployed(...filler, entry(REAL)) })
    expect(
      await readInstalledPasskeyKey([first, second], [REAL, OTHER], {
        reader,
        accountFactories: [FACTORY],
      }),
    ).toBeUndefined()
  })

  it("a stopped read starts no further step", async () => {
    const chain = { [accountOf(first)]: deployed(entry(REAL)) }

    const before = readerOver(chain)
    const stoppedBefore = new AbortController()
    stoppedBefore.abort()
    await expect(
      readInstalledPasskeyKey([first], [REAL, OTHER], {
        reader: before,
        accountFactories: [FACTORY],
        stop: stoppedBefore.signal,
      }),
    ).rejects.toThrow()
    expect(before.predictAccountAddress).not.toHaveBeenCalled()

    const afterPrediction = readerOver(chain)
    const stopAtPrediction = new AbortController()
    afterPrediction.predictAccountAddress.mockImplementation(async (_f, bootstrap) => {
      stopAtPrediction.abort()
      return `0x${bootstrap.slice(-40)}` as Address
    })
    await expect(
      readInstalledPasskeyKey([first], [REAL, OTHER], {
        reader: afterPrediction,
        accountFactories: [FACTORY],
        stop: stopAtPrediction.signal,
      }),
    ).rejects.toThrow()
    expect(afterPrediction.getCode).not.toHaveBeenCalled()

    const afterCode = readerOver(chain)
    const stopAtCode = new AbortController()
    afterCode.getCode.mockImplementation(async () => {
      stopAtCode.abort()
      return "0x6080" as Hex
    })
    await expect(
      readInstalledPasskeyKey([first], [REAL, OTHER], {
        reader: afterCode,
        accountFactories: [FACTORY],
        stop: stopAtCode.signal,
      }),
    ).rejects.toThrow()
    expect(afterCode.readAuthKeys).not.toHaveBeenCalled()
  })

  it("a sibling still predicting when the other fails starts nothing once stopped", async () => {
    const reader = readerOver({ [accountOf(second)]: deployed(entry(REAL)) })
    const stop = new AbortController()
    let releaseSecond!: () => void
    reader.predictAccountAddress.mockImplementation(async (_f, bootstrap) => {
      if (bootstrap === deriveBootstrapKey(second).address) {
        await new Promise<void>((resolve) => (releaseSecond = resolve))
      }
      return `0x${bootstrap.slice(-40)}` as Address
    })
    reader.getCode.mockImplementation(async (account) => {
      if (account === accountOf(first)) throw new Error("RPC down")
      return "0x6080" as Hex
    })
    await expect(
      readInstalledPasskeyKey([first, second], [REAL, OTHER], {
        reader,
        accountFactories: [FACTORY],
        stop: stop.signal,
      }),
    ).rejects.toThrow(/RPC down/)
    stop.abort()
    releaseSecond()
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(reader.getCode).toHaveBeenCalledTimes(1)
    expect(reader.readAuthKeys).not.toHaveBeenCalled()
  })

  it("any failed read rejects", async () => {
    const chain = { [accountOf(first)]: deployed(entry(REAL)) }
    for (const failing of ["predictAccountAddress", "getCode", "readAuthKeys"] as const) {
      const reader = readerOver(chain)
      reader[failing].mockRejectedValue(new Error("RPC down"))
      await expect(
        readInstalledPasskeyKey([first, second], [REAL, OTHER], {
          reader,
          accountFactories: [FACTORY],
        }),
      ).rejects.toThrow(/RPC down/)
    }
  })
})
