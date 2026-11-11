import { vi } from "vitest"
import { PaylinkActionEnum, TokenActionEnum } from "@obsidion/core/constants"
import type { Transaction } from "../../../src/types/transactions"
import {
  TransferEventScanner,
  type ScannedTransferEvent,
  type TransferEventSource,
  type TransferScanPass,
} from "../../../src/core/services/transactions/TransferEventScanner"
import { seededActivity } from "../../utils/transferFixture"

export const ME = "0x" + "aa".repeat(32)
export const ALICE = "0x" + "bb".repeat(32)
export const MALLORY = "0x" + "cc".repeat(32)
export const TOKEN = { address: "0x" + "11".repeat(32), symbol: "DAI", decimals: 6 }
export const STORE_WRITE_FAILED = new Error("store write failed")

export function event(overrides: Partial<ScannedTransferEvent> = {}): ScannedTransferEvent {
  return {
    txHash: "0x" + "01".repeat(32),
    from: ALICE,
    to: ME,
    amount: "5000000",
    blockNumber: 10,
    senderTag: "alice",
    ...overrides,
  }
}

/** A scanner over a seeded transfer store and a scripted event source. */
export function harness(opts: {
  contactTag?: string
  events?: ScannedTransferEvent[]
  head?: number | (() => number)
  /** PXE synced block; unset means the source has no anchorBlock. */
  anchor?: () => number
  /** Range-aware event source; wins over `events`. */
  list?: (fromBlock: number, toBlockExclusive: number) => ScannedTransferEvent[]
  resolve?: (tag: string) => Promise<{ l2Address: string } | null>
  /** Hashes already held by a row of some OTHER action (a paylink claim/refund). */
  otherRowHashes?: string[]
  /** Throw from the store write, to exercise a poison event. */
  addThrows?: () => boolean
  onSynced?: (anchor: number) => Promise<void>
  /** Block time read; defaults to `block * 1000`. Undefined means the node could not serve it. */
  blockTime?: (block: number) => number | undefined
  sourceTimeoutMs?: number
}) {
  const transfers = seededActivity(
    (opts.otherRowHashes ?? []).map((txHash) => ({
      action: PaylinkActionEnum.CLAIM,
      emailPaymentAction: PaylinkActionEnum.CLAIM,
      txHash,
      timestamp: 1,
      status: "success",
    })) as Transaction[],
  )
  const { backend } = transfers
  const adds: Transaction[] = []
  const payouts: Transaction[] = []
  const record = transfers.record.bind(transfers)
  vi.spyOn(transfers, "record").mockImplementation(async (row, recordOpts, w) => {
    if (opts.addThrows?.()) throw STORE_WRITE_FAILED
    ;(recordOpts?.replaces === TokenActionEnum.RECEIVE ? payouts : adds).push(row)
    return record(row, recordOpts, w)
  })
  const registered: { tag: string; l2Address: string }[] = []
  const listIncoming = vi.fn(async (a: number, b: number) =>
    opts.list ? opts.list(a, b) : opts.events ?? [],
  )
  const source: TransferEventSource = {
    headBlock: async () => (typeof opts.head === "function" ? opts.head() : opts.head ?? 100),
    listIncoming,
    blockTimestampMs: async (b) => (opts.blockTime ? opts.blockTime(b) : b * 1000),
    ...(opts.anchor ? { anchorBlock: async () => opts.anchor!() } : {}),
  }
  /** The persisted cursor, read straight from storage — call args are not proof of state. */
  const cursor = async () => Number(backend.entries.get(`acct/transferScanCursor/net/${ME}`) ?? 0)
  const scanner = new TransferEventScanner({
    source,
    db: transfers.db,
    transactionStore: transfers,
    tags: {
      resolveL2: opts.resolve ?? (async (tag) => (tag === "alice" ? { l2Address: ALICE } : null)),
    },
    contacts: {
      findByL2Address: async () => (opts.contactTag ? { tag: opts.contactTag } : null),
      registerL2: async (args) => void registered.push(args),
    },
    token: TOKEN,
    onSynced: opts.onSynced,
    sourceTimeoutMs: opts.sourceTimeoutMs,
  })
  const ctx = { accountAddress: ME, accountTag: "me", networkId: "net" }
  /** A full pass unless told otherwise: a wake, as the runtime runs on start, show and refresh. */
  const pass = (
    o: TransferScanPass = {},
    c: typeof ctx & { endpointScope?: string; ownAccount?: string } = ctx,
  ) => scanner.pass(c, { full: true, ...o })
  return { scanner, ctx, pass, adds, payouts, transfers, registered, listIncoming, cursor, backend }
}
