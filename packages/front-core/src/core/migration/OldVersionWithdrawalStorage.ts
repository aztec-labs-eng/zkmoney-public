import type { IStorageAdapter } from "../storages/adapter"
import { RecordStorage } from "../services/bridge/RecordStorage"

const KEY_OLD_VERSION_WITHDRAWALS = "@obsidion/migration/old-version-withdrawals"

/** One refund of a withdrawal, sent in a sponsored broadcast. */
export interface OldVersionRefund {
  /** The frozen portal that runs it on L1. */
  portal: string
  /** Its refund nullifiers: the portal's `WithdrawalOrRefund` log names one of them. */
  ids: string[]
  /** The deposits it refunds, by Inbox leaf index and amount. */
  deposits?: { leafIndex: string; amount: string }[]
  /** What it sends, net of the relayer's tip, in 18-decimal USD. */
  usd: string
  l2TxHash: string
  /** When its broadcast was sent. */
  sentAt?: number
  /** Set once the portal ran it. */
  l1TxHash?: string
  /** Its broadcast was dropped or reverted on L2, so it never runs and its funds stay to retry. */
  dropped?: boolean
}

/**
 * Old-version funds sent to an L1 address from zk.money. It is `sending` until its run sent its last
 * refund and the portal ran or L2 dropped each one, then `done`, or `failed` when none ran.
 */
export interface OldVersionWithdrawal {
  id: string
  startTime: number
  to: string
  /** What the relayers took, in 18-decimal USD. */
  feeUsd: string
  /** The L1 block the run began at: no refund ran before it. */
  fromBlock: string
  refunds: OldVersionRefund[]
  /** The run sent its last refund, or stopped: no refund joins the record after this. */
  allSent?: boolean
  phase: "sending" | "done" | "failed"
}

/** The withdrawals this front made from old versions. Strict: a sent refund must be durable. */
export class OldVersionWithdrawalStorage extends RecordStorage<OldVersionWithdrawal> {
  constructor(storage: IStorageAdapter) {
    super({
      storage,
      storageKey: KEY_OLD_VERSION_WITHDRAWALS,
      keyOf: (record) => record.id,
      sortBy: (record) => record.startTime,
      label: "OldVersionWithdrawalStorage",
      strict: true,
    })
  }

  get(id: string): OldVersionWithdrawal | null {
    return this.getByKey(id)
  }

  put(record: OldVersionWithdrawal): Promise<OldVersionWithdrawal> {
    return this.setRecord(record.id, record)
  }

  /** Changes the latest copy of `id`, so a run and a check that write at once both land. */
  update(
    id: string,
    change: (record: OldVersionWithdrawal) => OldVersionWithdrawal,
  ): Promise<OldVersionWithdrawal | null> {
    return this.updateRecord(id, (current) => current && change(current))
  }
}
