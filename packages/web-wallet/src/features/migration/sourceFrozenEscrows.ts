/**
 * The account's payment link escrows on a frozen source, registered in the source chain's wallet. A
 * link its funding transfer announces needs nothing local. The others come from this browser's link
 * rows the residual probe attributes to the source, in this rollup's database and earlier ones.
 */
import { AztecAddress } from "@aztec/aztec.js/addresses"
import type { Fr } from "@aztec/aztec.js/fields"
import type { OxideEnvTuple } from "@obsidion/core/types"
import {
  creatorLinksFromRows,
  TRANSACTIONS_STORAGE_KEY,
  TransactionStorage,
  type PaylinkTransaction,
  type Transaction,
} from "@obsidion/front-core"
import {
  ContractService,
  createTransferEventSource,
  discoverFrozenEscrows,
  PaylinkService,
  TokenService,
  type FrozenEscrow,
  type ObsidionAccount,
  type ObsidionWallet,
} from "@obsidion/sdk"
import { getConfig } from "../../config/env"
import { SessionChangedError } from "../../platform/auth/sessionErrors"
import { getActiveStorageId } from "../../platform/storage/activeStorage"
import { webStorage } from "../../platform/storage/WebStorageAdapter"
import { isHistoricPaylinkRow } from "./historicResiduals"

export async function sourceFrozenEscrows(o: {
  chain: { wallet: ObsidionWallet; account: ObsidionAccount }
  tuple: OxideEnvTuple
  /** The current deployment, whose creation dates a legacy row with no token address. */
  current: OxideEnvTuple
  masterSecret: Fr
  /** The account the scan started for, whose rows alone it reads. */
  storageId: string
}): Promise<FrozenEscrow[]> {
  const { wallet, account } = o.chain
  const token = AztecAddress.fromStringUnsafe(o.tuple.l2Token)
  const tokenService = await TokenService.create(wallet, account, token)
  const contractService = ContractService.getInstance()
  const hints = await sourceLinks(o.tuple, o.current, o.storageId)
  const escrows = await discoverFrozenEscrows({
    paylinkService: new PaylinkService(wallet, account, tokenService, contractService),
    escrows: { wallet, contractService },
    events: createTransferEventSource({
      wallet,
      tokenAddress: o.tuple.l2Token,
      accountAddress: account.getAddress().toString(),
    }),
    account: account.getAddress(),
    masterSecret: o.masterSecret,
    hints,
  })
  // A recorded link with no escrow is not refunded; the SDK logs why it did not rebuild.
  console.info(
    `[frozen-escrows] ${hints.length} links recorded here, ${escrows.length} escrows found`,
  )
  return escrows
}

/**
 * The source's links among this browser's rows. A legacy row's link from another chain is not its.
 * An account switch during the read fails it, so one account's links never reach another's refund.
 */
async function sourceLinks(tuple: OxideEnvTuple, current: OxideEnvTuple, storageId: string) {
  const checkSession = () => {
    if (getActiveStorageId() !== storageId) throw new SessionChangedError()
  }
  checkSession()
  const since = Date.parse(current.timestamp)
  const rows = (await browserRows()).filter((row) =>
    isHistoricPaylinkRow(row as PaylinkTransaction, tuple, since),
  )
  checkSession()
  const links = await creatorLinksFromRows(rows)
  checkSession()
  return links.filter(
    (link) =>
      link.chainId === getConfig().l1ChainId && link.rollupVersion === Number(tuple.rollupVersion),
  )
}

/**
 * This account's rows here and in every other rollup's database. A database that can't be read fails
 * the read, so a hint is never silently missing; a malformed copy holds nothing to recover.
 */
async function browserRows(): Promise<Transaction[]> {
  const rows = [...((await TransactionStorage.get(webStorage).getTransactions()) ?? [])]
  for (const raw of await webStorage.getItemFromOtherDatabases(TRANSACTIONS_STORAGE_KEY)) {
    try {
      const parsed: unknown = JSON.parse(raw)
      if (Array.isArray(parsed)) rows.push(...(parsed as Transaction[]))
    } catch {
      // Malformed: nothing to recover from it.
    }
  }
  return rows
}
