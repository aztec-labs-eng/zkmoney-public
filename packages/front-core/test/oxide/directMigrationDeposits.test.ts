// @vitest-environment node
import { describe, expect, it, vi } from "vitest"
import type { Address, Hex } from "viem"
import { ensureDirectMigrationDepositRecords } from "../../src/oxide/directMigrationDeposits"
import { openDatabase } from "../../src/engine/database"
import { memoryBackend } from "../../src/engine/memoryBackend"
import {
  claimedSweepsTotal,
  createSipaDeposits,
  directDepositKey,
  directDepositSettled,
  type SipaDeposit,
} from "../../src/engine/sipaDeposits"
import type { SipaRow } from "../../src/oxide/sipaRows"

const DAI_PORTAL = "0x00000000000000000000000000000000000000a0" as Address
const SUSDS_PORTAL = "0x00000000000000000000000000000000000000a5" as Address
const EXECUTOR = "0x00000000000000000000000000000000000000e5" as Address
const SUBSIDY = "0x00000000000000000000000000000000000000f5" as Address
const COMMITMENT = `0x${"0c".repeat(32)}` as Hex
const SECRET = 0x1234n
const RECIPIENT = `0x${"2a".repeat(32)}`

const token = (address: string, symbol: string) => ({
  address: address as Address,
  symbol,
  decimals: 18,
})
const ROWS: SipaRow[] = [
  {
    portal: DAI_PORTAL,
    l2Token: "0xdai",
    token: token("0x00000000000000000000000000000000000000d1", "DAI"),
    swapped: [],
    intents: ["deposit", "registration", "metadata"],
  },
  {
    portal: SUSDS_PORTAL,
    l2Token: "0xsusds",
    token: token("0x00000000000000000000000000000000000000d5", "sUSDS"),
    swapped: [],
    intents: ["deposit"],
  },
]
const direct = {
  executor: EXECUTOR,
  subsidy: SUBSIDY,
  day: 3,
  nonce: 9,
  recipientCommitment: COMMITMENT,
}

/** The deposit store over memory, its records as a map once loaded, and a spy on its writes. */
function makeStore() {
  const store = createSipaDeposits({ db: openDatabase(memoryBackend()), account: true })
  const held = {
    ...store,
    get records() {
      return new Map(store.view.get().records.map((r) => [r.sipaAddress.toLowerCase(), r]))
    },
    seed: (record: Partial<SipaDeposit>) =>
      store.adopt({ networkId: "0x00000000000000000000000000000000000000e1", ...record } as never),
  }
  return Object.assign(held, { apply: vi.fn(held.apply) })
}

const RUN = `metadata-migration/${SUSDS_PORTAL}/0xold/${RECIPIENT}`
/** What the batch deposits, raw units. */
const AMOUNT = "5000000000000000000"

function makeDeps(
  store = makeStore(),
  batches: { run: string; direct: typeof direct; fromBlock: string; amount: string }[] = [
    { run: RUN, direct, fromBlock: "1500", amount: AMOUNT },
  ],
) {
  const secret = vi.fn(async () => ({ recipientCommitment: COMMITMENT, sharedSecret: SECRET }))
  return {
    store,
    secret,
    deps: {
      store,
      batches: async () => batches,
      rows: ROWS,
      destinationPortal: (batch: { run: string }) => batch.run.split("/")[1] as Address,
      recipient: RECIPIENT,
      l1ChainId: 1,
      networkId: "0x00000000000000000000000000000000000000e1",
      secret,
    },
  }
}

/** A client that fails any read: the ensure step must make none. */
const noReads = new Proxy({} as Record<string, unknown>, {
  get: (_t, name) => () => {
    throw new Error(`unexpected L1 read: ${String(name)}`)
  },
})

describe("ensureDirectMigrationDepositRecords", () => {
  it("records a sent batch before its deposit lands, as an unpaid address, reading no chain", async () => {
    const { deps, store, secret } = makeDeps()

    expect(
      await ensureDirectMigrationDepositRecords({ ...deps, publicClient: noReads } as never),
    ).toBe(1)

    expect(secret).toHaveBeenCalledWith(direct)
    const record = store.records.get(directDepositKey(COMMITMENT).toLowerCase())!
    expect(record).toMatchObject({
      phase: "broadcast",
      recipientL2Address: RECIPIENT,
      recipientHash: COMMITMENT,
      direct: { recipientCommitment: COMMITMENT, executor: EXECUTOR, expected: AMOUNT },
      amount: "0",
      fee: "0",
      tokenSymbol: "sUSDS",
      tokenAddress: ROWS[1]!.token.address,
      observedFrom: "1500",
      rescanFrom: "1500",
    })
    expect(record.inboxIndex).toBeUndefined()
    expect(record.sweepTxHash).toBeUndefined()
    expect(record.pendingSweeps).toBeUndefined()
    // The claim's shared-secret salt, as an Fr.
    expect(BigInt(record.messageSecret)).toBe(SECRET)
  })

  it("writes nothing for a batch already recorded", async () => {
    const { deps, store } = makeDeps()
    await ensureDirectMigrationDepositRecords(deps)
    store.apply.mockClear()

    expect(await ensureDirectMigrationDepositRecords(deps)).toBe(0)
    expect(store.apply).not.toHaveBeenCalled()
  })

  it("gives a record written from the deposit's announcement the batch's amount", async () => {
    const { deps, store } = makeDeps()
    const key = directDepositKey(COMMITMENT).toLowerCase()
    await store.seed({
      sipaAddress: key as Address,
      phase: "claimed",
      claimedInboxIndexes: ["1"],
      direct: { recipientCommitment: COMMITMENT },
    })

    expect(await ensureDirectMigrationDepositRecords(deps)).toBe(0)

    expect(store.records.get(key)).toMatchObject({
      phase: "claimed",
      claimedInboxIndexes: ["1"],
      direct: { recipientCommitment: COMMITMENT, expected: AMOUNT },
    })
  })

  it("refuses a batch whose commitment its coordinates do not derive", async () => {
    const { deps, store, secret } = makeDeps()
    secret.mockResolvedValue({ recipientCommitment: `0x${"0d".repeat(32)}`, sharedSecret: SECRET })

    expect(await ensureDirectMigrationDepositRecords(deps)).toBe(0)
    expect(store.apply).not.toHaveBeenCalled()
  })

  it("isolates a batch whose destination has no rail row", async () => {
    const other = `0x${"0f".repeat(32)}` as Hex
    const { deps, store } = makeDeps(makeStore(), [
      {
        run: "metadata-migration/0xunknown/0xold/0xacct",
        direct: { ...direct, recipientCommitment: other },
        fromBlock: "1",
        amount: AMOUNT,
      },
      { run: RUN, direct, fromBlock: "1500", amount: AMOUNT },
    ])

    expect(await ensureDirectMigrationDepositRecords(deps)).toBe(1)
    expect(store.records.has(directDepositKey(COMMITMENT).toLowerCase())).toBe(true)
  })
})

describe("claimedSweepsTotal", () => {
  it("is the total the rail claimed under the commitment, with no deposit it has only seen", () => {
    expect(claimedSweepsTotal(undefined)).toBe(0n)
    const seen = { phase: "pendingClaim", inboxIndex: "42", pendingSweeps: [{ inboxIndex: "42" }] }
    expect(claimedSweepsTotal(seen as never)).toBe(0n)
    // Another sender's dust is claimed first; the batch's deposit waits for its claim.
    const first = {
      phase: "pendingClaim",
      inboxIndex: "43",
      claimedInboxIndexes: ["42"],
      sweeps: [{ inboxIndex: "42", netAmount: "1" }],
      pendingSweeps: [{ inboxIndex: "43" }],
    }
    expect(claimedSweepsTotal(first as never)).toBe(1n)
    const both = {
      phase: "claimed",
      inboxIndex: "43",
      claimedInboxIndexes: ["42", "43"],
      sweeps: [
        { inboxIndex: "42", netAmount: "1" },
        { inboxIndex: "43", netAmount: AMOUNT },
      ],
    }
    expect(claimedSweepsTotal(both as never)).toBe(BigInt(AMOUNT) + 1n)
    // The key is the commitment's, whatever its case.
    expect(directDepositKey(COMMITMENT.toUpperCase().replace("0X", "0x") as Hex)).toBe(
      directDepositKey(COMMITMENT),
    )
  })
})

describe("directDepositSettled", () => {
  const record = (claimed: string[], expected?: string) =>
    ({
      phase: "claimed",
      claimedInboxIndexes: claimed,
      sweeps: claimed.map((inboxIndex) => ({
        inboxIndex,
        netAmount: inboxIndex === "1" ? "1" : AMOUNT,
      })),
      direct: { recipientCommitment: COMMITMENT, ...(expected ? { expected } : {}) },
    } as never)

  it("settles once the claimed total reaches the batch's amount, and never without one", () => {
    expect(directDepositSettled(record(["1"], AMOUNT))).toBe(false)
    expect(directDepositSettled(record(["1", "2"], AMOUNT))).toBe(true)
    expect(directDepositSettled(record(["2"], AMOUNT))).toBe(true)
    expect(directDepositSettled(record(["2"]))).toBe(false)
  })
})
