/** The feed's sources and records, as the feed tests build them. */
import type { MoveRecord } from "../../src/engine/moveTransition"
import type { UpgradeBatchItem } from "../../src/core/migration/upgradeActivity"
import type { OldVersionWithdrawal } from "../../src/core/migration/OldVersionWithdrawalStorage"
import type { WithdrawalRecord } from "../../src/core/services/bridge/types"
import type { BridgeInRecord } from "../../src/core/services/crossChain/types"
import type { SipaDeposit } from "../../src/engine/sipaDeposits"
import type { BackupRotationRecord } from "../../src/engine/backupRotations"
import type { ContactRow } from "../../src/engine/contacts"
import {
  selectFeed,
  type FeedContext,
  type FeedItem,
  type FeedSources,
} from "../../src/engine/activityFeed"
import type { PaymentRequest } from "../../src/engine/requests"
import type { Transaction } from "../../src/types/transactions"
import type { OperationRecord } from "../../src/engine/operationTransition"
import type { PaylinkRecord } from "../../src/engine/paylinkTransition"

export const NOW = 1_800_000_000_000
export const HOUR = 3_600_000
export const E18 = 10n ** 18n
export const addr = (byte: string) => `0x${byte.repeat(20)}`
export const token = {
  address: "0xt",
  name: "DAI",
  symbol: "DAI",
  decimals: 18,
  logo: "",
  amount: 0,
  price: 1,
}

export const tx = (over: Partial<Transaction> & { action: string }): Transaction =>
  ({
    id: over.txHash ?? "op",
    token,
    amountAtomic: 5n * E18,
    timestamp: NOW - HOUR,
    status: "success",
    txHash: "0xaa",
    ...over,
  } as Transaction)

export const link = (over: Partial<PaylinkRecord> = {}): PaylinkRecord => ({
  id: over.txHash ?? "link",
  flavor: "direct",
  token,
  amountAtomic: 5n * E18,
  timestamp: NOW - HOUR,
  payToEmailSecret: "0xs",
  ...over,
})

export const request = (over: Partial<PaymentRequest> = {}): PaymentRequest => ({
  id: "req",
  contactTag: "ada",
  amount: 10,
  amountAtomic: (10n * E18).toString(),
  tokenDecimals: 18,
  asset: "DAI",
  direction: "incoming",
  status: "pending",
  createdAt: NOW - 2 * HOUR,
  kind: "contact",
  ...over,
})

export const deposit = (over: Partial<SipaDeposit> = {}): SipaDeposit =>
  ({
    sipaAddress: addr("d1"),
    phase: "claimed",
    amount: "20",
    netAmount: (20n * E18).toString(),
    fee: "0",
    startTime: NOW - 3 * HOUR,
    ...over,
  } as SipaDeposit)

export const burn = (over: Partial<WithdrawalRecord> = {}): WithdrawalRecord =>
  ({
    localId: "w1",
    recipient: addr("e1"),
    amount: "7",
    tokenSymbol: "DAI",
    phase: "done",
    startTime: NOW - 4 * HOUR,
    endTime: NOW - 4 * HOUR,
    ...over,
  } as WithdrawalRecord)

export const ada: ContactRow = {
  id: "ada",
  name: "Ada",
  tag: "ada",
  address: "0xada",
  addressKind: "aztec-l2",
}

export function feedOf(
  over: Partial<{
    rows: Transaction[]
    links: PaylinkRecord[]
    operations: OperationRecord[]
    requests: PaymentRequest[]
    deposits: SipaDeposit[]
    withdrawals: WithdrawalRecord[]
    bridgeIns: BridgeInRecord[]
    bridgeInsHydrated: boolean
    upgrades: UpgradeBatchItem[]
    upgradesLoaded: boolean
    oldVersionWithdrawals: OldVersionWithdrawal[]
    rotations: BackupRotationRecord[] | "unread"
    catchingUp: boolean
    moves: MoveRecord[]
    movesReplayed: boolean
  }> = {},
  ctx: Partial<FeedContext> = {},
) {
  const sources: FeedSources = {
    rows: { records: over.rows ?? [], loaded: true, failed: false },
    links: { records: over.links ?? [], loaded: true, failed: false },
    operations: { records: over.operations ?? [], loaded: true, failed: false },
    requests: over.requests ?? [],
    deposits: { records: over.deposits ?? [], loaded: true, failed: false },
    withdrawals: { records: over.withdrawals ?? [], hydrated: true },
    bridgeIns: { records: over.bridgeIns ?? [], hydrated: over.bridgeInsHydrated ?? true },
    upgrades: {
      items: over.upgrades ?? [],
      recipients: new Set((over.upgrades ?? []).map((b) => b.recipient.toLowerCase())),
      loaded: over.upgradesLoaded ?? true,
    },
    moves: { records: over.moves ?? [], loaded: true, failed: false },
    movesReplayed: over.movesReplayed ?? true,
    oldVersionWithdrawals: over.oldVersionWithdrawals ?? [],
    processing: new Map(),
    rotations: over.rotations ?? [],
    catchingUp: over.catchingUp ?? false,
    now: NOW,
  }
  return selectFeed(sources, {
    contacts: { rows: [ada], hydrated: true, failed: false },
    registrations: { records: [] },
    ...ctx,
  })
}

export const kinds = (items: readonly FeedItem[]) => items.map((i) => `${i.kind}:${i.id}`)
