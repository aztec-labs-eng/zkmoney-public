import { TxExecutionResult, TxStatus } from "@aztec-labs/stdlib/tx"
import { BACKUP_FUNDING_MARGIN } from "@obsidion/sdk"
import type { PersistedRotationVerdict, SpendShape } from "@obsidion/sdk"
import { vi } from "vitest"
import type {
  FundingRow,
  RotationFlowDeps,
  SweepSeen,
} from "../../../src/core/rotation/backupRotationFlow"
import { createBackupRotations, persistedRotation } from "../../../src/engine/backupRotations"
import { openDatabase } from "../../../src/engine/database"
import { memoryBackend } from "../../../src/engine/memoryBackend"
import { PLAN, signedRecord, storedRotation, word } from "../../__test-helpers__/backupRotation"

/** The rotations over `entries`: a reopen over the same entries is a reload. */
export const reopen = (entries: Map<string, string>) =>
  createBackupRotations({ db: openDatabase(memoryBackend(entries)) })

export const VERIFIED = { verdict: "verified" } as unknown as PersistedRotationVerdict
export const CORRUPT: PersistedRotationVerdict = { verdict: "corrupt", reason: "the signature" }
export const DAI = 10n ** 18n
/** A plan whose funding leaves 2 DAI at the deposit address. */
export const DEPOSITING = {
  ...PLAN,
  fundingAmount: ((21n * DAI) / 10n).toString(),
  deposited: (2n * DAI).toString(),
  credited: ((14n * DAI) / 10n).toString(),
}
/** The floor of `DEPOSITING`: its deposit less its credit's margin. */
export const FLOOR = 2n * DAI - BACKUP_FUNDING_MARGIN
export const receipt = (status: TxStatus, reverted = false, block = 9) => ({
  status,
  executionResult: reverted ? TxExecutionResult.REVERTED : TxExecutionResult.SUCCESS,
  blockNumber: block,
  blockHash: `0xb${block}`,
})

/** The deposit address's balance at the latest block and at the settled one. */
export const balances = (deps: RotationFlowDeps, latest: bigint, settled: bigint) =>
  (deps.l1.sipaBalance as ReturnType<typeof vi.fn>).mockImplementation(
    async (_sipa: string, at?: unknown) => (at === "latest" ? latest : settled),
  )

export interface World {
  clock: { t: number }
  receipts: Map<string, ReturnType<typeof receipt>>
  finalizedAt: number
  rows: Map<string, FundingRow>
  balance: bigint
  sweep?: SweepSeen
  recovery?: `0x${string}`
  /** The L1 block a recovery landed in. */
  recoveryBlock: number
  /** The settled L1 block: a block above it is not settled. */
  l1Settled: number
  settled: boolean
  releaseSettled: boolean
  shape: SpendShape
  hashes: number
  /** The open paylinks the one-key account made. */
  links: string[]
  refundable: Record<string, "now" | "later" | "spending" | "spent">
}

export function harness(over: Partial<World> = {}) {
  const world: World = {
    clock: { t: 2000 },
    receipts: new Map(),
    finalizedAt: 0,
    rows: new Map(),
    balance: 0n,
    recoveryBlock: 70,
    l1Settled: 100,
    settled: true,
    releaseSettled: true,
    shape: { notes: [3n * DAI], depositTotal: 0n, balance: 3n * DAI },
    hashes: 0,
    links: [],
    refundable: {},
    ...over,
  }
  const storage = new Map<string, string>()
  const store = reopen(storage)
  let minted = 1
  const nextHash = () => word(0x100 + ++world.hashes)
  const deps: RotationFlowDeps = {
    store,
    now: () => world.clock.t,
    mintAttemptId: () => `attempt-${++minted}`,
    activeSince: 1000,
    session: "life-1",
    verify: vi.fn(async () => VERIFIED),
    fundability: vi.fn(async () => "fundable" as const),
    route: vi.fn(async () => "ok" as const),
    l1: {
      settledBlock: vi.fn(async () => ({ number: world.l1Settled, hash: word(0xf1) })),
      isSettled: vi.fn(async ({ blockNumber }) => world.settled && blockNumber <= world.l1Settled),
      txBlock: vi.fn(async () => ({ blockNumber: world.recoveryBlock, blockHash: word(0x70) })),
      sipaBalance: vi.fn(async () => world.balance),
      sweep: vi.fn(async () => world.sweep),
      recovery: vi.fn(async () => world.recovery),
      releaseSettled: vi.fn(async () => world.releaseSettled),
    },
    node: {
      getTxReceipt: vi.fn(async (hash: string) => {
        const r = world.receipts.get(hash)
        if (r === undefined) return receipt(TxStatus.DROPPED)
        return r
      }),
      finalizedTimestampMs: vi.fn(async () => world.finalizedAt),
    },
    tracker: {
      row: vi.fn(async (localId: string) => world.rows.get(localId)),
      stamp: vi.fn(async () => undefined),
    },
    sign: vi.fn(async () => "0x26" as const),
    publish: vi.fn(async () => undefined),
    republish: vi.fn(async () => undefined),
    fund: vi.fn(async (_r, _f, onTxHash) => {
      const hash = nextHash()
      world.receipts.set(hash, receipt(TxStatus.PENDING))
      await onTxHash(hash, { expiresAtMs: 5000 })
    }),
    reroot: vi.fn(async () => ({ switched: true, rebound: true })),
    move: {
      tokens: vi.fn(async () => ["tok"]),
      shape: vi.fn(async () => world.shape),
      deposits: vi.fn(async () => ({ kind: "exact" as const, amounts: [] })),
      cap: vi.fn(async () => 2n * DAI),
      usesLeft: vi.fn(async () => true),
      send: vi.fn(async (_t: string, _a: bigint, onTxHash) => {
        const hash = nextHash()
        world.receipts.set(hash, receipt(TxStatus.PENDING))
        await onTxHash(hash, { expiresAtMs: 5000 })
      }),
      links: vi.fn(async () => world.links),
      refundable: vi.fn(async (link: string) => world.refundable[link] ?? "now"),
      refund: vi.fn(async (_l: string, onTxHash) => {
        const hash = nextHash()
        world.receipts.set(hash, receipt(TxStatus.PENDING))
        await onTxHash(hash, { expiresAtMs: 5000 })
      }),
      declined: vi.fn(
        (err: unknown) => err instanceof DOMException && err.name === "NotAllowedError",
      ),
    },
  }
  return { deps, world, store, storage }
}

export const prepared = (() => {
  const { signature: _s, ...rest } = persistedRotation(storedRotation())
  return rest
})()

export const finish = (record: ReturnType<typeof signedRecord>) => {
  const { envelopeHex: _e, ...backup } = record.backup
  const { signature: _s, add, ...rotation } = record.rotation!
  const { envelope: _v, ...addRest } = add
  return { ...record, backup, rotation: { ...rotation, add: addRest } }
}
