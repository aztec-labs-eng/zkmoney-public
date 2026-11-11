/** The move check: the one shape a backup add leaves, and nothing else, moves a record's account. */
import { Fr } from "@aztec-labs/aztec.js/fields"
import { deriveBootstrapKey, type OxideIdentityDeps } from "@obsidion/front-core"
import { predictAccountAddressLocally } from "@oxide/l1-contracts"
import { getContractAddress, type Address } from "viem"
import { afterEach, describe, expect, it, vi } from "vitest"
import {
  clearMovedAccountMark,
  markMovedAccount,
  movedAccount,
  movedAccountMark,
  type MovedAccountCheck,
} from "../../../src/features/identity/movedAccount"

const msk = Fr.random()
const BOOTSTRAP = deriveBootstrapKey(msk).address
const CURRENT_FACTORY = `0x${"11".repeat(20)}` as Address
const RETIRED_FACTORY = `0x${"19".repeat(20)}` as Address
const REGISTRY = `0x${"22".repeat(20)}` as Address
const METADATA = `0x${"23".repeat(20)}` as Address
/** The account each generation's factory predicts for the held key. */
const ACCOUNT = predictAccountAddressLocally(CURRENT_FACTORY, BOOTSTRAP)
const RETIRED_ACCOUNT = predictAccountAddressLocally(RETIRED_FACTORY, BOOTSTRAP)
const OLD = `0x${"aa".repeat(32)}`
const NEW = `0x${"bb".repeat(32)}`
const ROOT = "ab".repeat(64)
const BACKUP = "cd".repeat(64)
const OTHER = "ef".repeat(64)
const NAME = `0x${"5a".repeat(32)}`
const NAMELESS = `0x${"0".repeat(64)}`

const generation = (accountFactory: Address, rollupVersion: string) => ({
  fpcAddress: `0x${"0b".repeat(32)}`,
  accountFactory,
  namePortal: `${accountFactory.slice(0, 40)}ee` as Address,
  rollupVersion,
})

/** The chain the identity resolver reads: which accounts hold a name, and what the user record says. */
function chain(
  over: { named?: Address[]; record?: { l2Address: string; rollupVersion: bigint } } = {},
) {
  const named = over.named ?? [ACCOUNT]
  const record = over.record ?? { l2Address: NEW, rollupVersion: 1n }
  return {
    readNameOf: async (_registry: Address, account: Address) =>
      named.some((a) => a.toLowerCase() === account.toLowerCase()) ? NAME : NAMELESS,
    readAccountMetadataRegistry: async () => METADATA,
    readUserRecord: async () => record,
    readNamePortalRegistry: async () => REGISTRY,
    readFactoryImplementation: async (factory: Address) =>
      getContractAddress({ from: factory, nonce: 1n }),
  }
}

/** The deployment as the sign-in loads it: the current rollup and one retired one, both admissible. */
const generations = (reader: ReturnType<typeof chain>): OxideIdentityDeps => ({
  reader: reader as unknown as OxideIdentityDeps["reader"],
  registry: REGISTRY,
  rollupVersion: "1",
  admissibleRollupVersions: new Set(["1", "0"]),
  catalog: [generation(CURRENT_FACTORY, "1"), generation(RETIRED_FACTORY, "0")],
})

const entry = (key: string) => ({
  key: { qx: `0x${key.slice(0, 64)}`, qy: `0x${key.slice(64)}` },
  metadata: "0x",
})
const listing = (keys: string[], authKeyCount = keys.length) => ({
  entries: keys.map(entry),
  authKeyCount,
})

/** The address exists under the two-key set alone; the key alone derives the old one. */
const derive = async (_msk: Fr, keys: readonly string[]) =>
  keys.length === 2 && keys.includes(ROOT) ? NEW : OLD

type Over = {
  list?: ReturnType<typeof listing>
  record?: MovedAccountCheck["record"]
  accounts?: Address[]
  chain?: Parameters<typeof chain>[0]
}

const run = (over: Over = {}) => {
  const readAuthKeys = vi.fn(async () => (over.list ?? listing([ROOT, BACKUP])) as never)
  const result = movedAccount({
    generations: generations(chain(over.chain)),
    bootstrap: BOOTSTRAP,
    accounts: over.accounts ?? [ACCOUNT],
    record: over.record ?? { pubkey: ROOT },
    msk,
    readAuthKeys,
    derive,
  })
  return { result, readAuthKeys }
}

describe("movedAccount", () => {
  it("names the two-key account when the list is the record's key plus one and the record names its address", async () => {
    const { result, readAuthKeys } = run()
    expect(await result).toEqual({
      identity: {
        account: ACCOUNT,
        nameHash: NAME,
        generations: [generation(CURRENT_FACTORY, "1")],
      },
      passkeys: [ROOT, BACKUP],
      address: NEW,
    })
    expect(readAuthKeys).toHaveBeenCalledWith(ACCOUNT)
  })

  it.each([
    ["one key", listing([ROOT])],
    ["three keys", listing([ROOT, BACKUP, OTHER])],
    ["two keys without the record's", listing([OTHER, BACKUP])],
    ["a truncated read", listing([ROOT, BACKUP], 3)],
  ])("leaves %s alone", async (_shape, list) => {
    expect(await run({ list }).result).toBeUndefined()
  })

  it("leaves a list with a key that is not 64 bytes alone", async () => {
    const list = {
      entries: [entry(ROOT), { key: { qx: "0x1234", qy: "0x" }, metadata: "0x" }],
      authKeyCount: 2,
    }
    expect(await run({ list }).result).toBeUndefined()
  })

  it("collapses a key listed twice before counting", async () => {
    expect(await run({ list: listing([ROOT, ROOT, BACKUP]) }).result).toMatchObject({
      passkeys: [ROOT, BACKUP],
    })
  })

  it("reads nothing for a record whose set already holds two keys", async () => {
    const { result, readAuthKeys } = run({ record: { pubkey: ROOT, passkeySet: [ROOT, BACKUP] } })
    expect(await result).toBeUndefined()
    expect(readAuthKeys).not.toHaveBeenCalled()
  })

  it("admits the current rollup alone: an account verified only through a retired rollup is no move", async () => {
    const { result } = run({
      accounts: [RETIRED_ACCOUNT],
      chain: { named: [RETIRED_ACCOUNT], record: { l2Address: NEW, rollupVersion: 0n } },
    })
    expect(await result).toBeUndefined()
  })

  it("is no move while the user record names neither the old address nor the derived one", async () => {
    const { result } = run({
      chain: { record: { l2Address: `0x${"cc".repeat(32)}`, rollupVersion: 1n } },
    })
    expect(await result).toBeUndefined()
  })

  it("lets a failed key read propagate", async () => {
    const failure = new Error("rpc down")
    const readAuthKeys = vi.fn(async () => {
      throw failure
    })
    await expect(
      movedAccount({
        generations: generations(chain()),
        bootstrap: BOOTSTRAP,
        accounts: [ACCOUNT],
        record: { pubkey: ROOT },
        msk,
        readAuthKeys,
        derive,
      }),
    ).rejects.toBe(failure)
  })
})

describe("the moved-account mark", () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    sessionStorage.clear()
  })

  it("holds the address until cleared", () => {
    markMovedAccount(NEW)
    expect(movedAccountMark()).toBe(NEW)
    clearMovedAccountMark()
    expect(movedAccountMark()).toBeUndefined()
  })

  it("swallows a storage that throws", () => {
    const blocked = () => {
      throw new Error("blocked")
    }
    vi.stubGlobal("sessionStorage", { getItem: blocked, setItem: blocked, removeItem: blocked })
    expect(() => markMovedAccount(NEW)).not.toThrow()
    expect(movedAccountMark()).toBeUndefined()
    expect(() => clearMovedAccountMark()).not.toThrow()
  })
})
