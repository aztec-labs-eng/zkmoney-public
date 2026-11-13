/**
 * Settings recovery for a previous version's deposit address whose sweep is stuck in its frozen
 * portal: the refund proof for that address's deposits alone, paid to an Ethereum address the user
 * picks. The user's L1 wallet submits it and pays the gas.
 */
import type { Address } from "viem"
import { bridgeUnderlying } from "@obsidion/core/oxide"
import { type SipaDeposit } from "@obsidion/front-core"
import type { FrozenRefundCandidate } from "@obsidion/sdk"
import { l1PublicClient } from "../../../config/oxideTuple"
import type { Session } from "../../../session/session"
import { createWebMetadataMigration } from "../../migration/createWebMetadataMigration"
import {
  noteOldVersionWithdrawn,
  openOldVersionExit,
  type WithdrawableSource,
} from "../../migration/oldVersionWithdraw"
import { sweptDepositsOf } from "../../migration/sourceSipaSources"
import { portalContract } from "../../token/oxideToken"
import { tokenMetadata } from "../../sipa/loadDepositFacts"
import {
  runFrozenExit,
  type FrozenExitProgress,
  type FrozenExitRuntime,
} from "../../withdraw/frozenExitRun"
import { refundedMoves } from "./refundedMoves"
import type { L1ExitChannel } from "../../sipa/l1ExitChannels"
import copy from "./sipaRecovery.copy"

/** One deposit address's sweeps that a frozen old version's portal still holds. */
export interface FrozenDeposit {
  source: Pick<WithdrawableSource, "source" | "open">
  /** Inbox leaf indexes of the address's sweeps, decimal. */
  leafIndexes: string[]
  amount: bigint
  symbol: string
  decimals: number
}

/**
 * `record`'s sweeps into a frozen old version's portal, or null when no such portal holds any. The
 * migration check may not know the address, so its sweeps go to the refund runtime with it.
 */
export async function findFrozenDeposit(
  session: Session,
  record: SipaDeposit,
): Promise<FrozenDeposit | null> {
  const { sipaDeposits, wallet, account, token, contractService, auth, page } = session
  const { config } = session.page
  if (!account || !token) throw new Error(copy.signInToRefund)
  const publicClient = l1PublicClient(config)
  const [current, sources, head] = await Promise.all([
    session.page.chain.oxideTuple.read(),
    session.page.chain.retiredRollupSources.read(),
    publicClient.getBlockNumber({ cacheTime: 0 }),
  ])
  for (const tuple of sources) {
    // A deployment without SIPAs, such as Sky savings, handed out no deposit address.
    if (!tuple.depositSIPAImplementation && !tuple.registrationSIPAImplementation) continue
    if (!(await portalContract(publicClient, tuple.portal as Address).isFrozen())) continue
    const { descriptors } = await sweptDepositsOf({ page, publicClient, tuple, scanHead: head }, [
      {
        sipaAddress: record.sipaAddress,
        recipientL2Address: record.recipientL2Address,
        messageSecret: record.messageSecret,
        recipientCommitment: record.recipientHash,
      },
    ])
    if (!descriptors.length) continue
    const { symbol, decimals } = await tokenMetadata(
      session.page,
      bridgeUnderlying(tuple) as Address,
    )
    return {
      source: {
        source: tuple,
        open: async (tipRecipient) =>
          createWebMetadataMigration({
            wallet: await wallet.ready(),
            account: await account.ready(),
            deposits: sipaDeposits,
            auth,
            own: session,
            handle: session.identity.get().value?.handle,
            contractService: await contractService.ready(),
            toTokenService: await token.ready(),
            historic: tuple,
            current,
            withdrawal: true,
            tipRecipient,
            extraDeposits: descriptors,
          }),
      },
      leafIndexes: descriptors.map((d) => d.messageLeafIndex),
      amount: descriptors.reduce((sum, d) => sum + BigInt(d.amount), 0n),
      symbol,
      decimals,
    }
  }
  return null
}

/** The deposit refunds among `candidates` that name one of `leafIndexes`. */
export const pickFrozenDeposits = (
  candidates: readonly FrozenRefundCandidate[],
  leafIndexes: readonly string[],
) =>
  candidates.filter(
    (c) =>
      (c.kind === "frozen-deposit" || c.kind === "unprocessed-deposit") &&
      c.leafIndex !== undefined &&
      leafIndexes.includes(c.leafIndex),
  )

/** Refunds `found` to `recipient` in a frozen exit's batches. The submitter pays the gas. */
export async function refundFrozenDeposit(
  session: Pick<Session, "page" | "moves">,
  found: FrozenDeposit,
  recipient: Address,
  channel: L1ExitChannel,
  onBatch?: (progress: FrozenExitProgress) => void,
) {
  const exit = await openOldVersionExit(session.page.config, found.source, channel.target)
  const runtime: FrozenExitRuntime = {
    build: (...args) => exit.runtime.build(...args),
    candidates: async (opts) => {
      const read = await exit.runtime.candidates(opts)
      return { ...read, candidates: pickFrozenDeposits(read.candidates, found.leafIndexes) }
    },
  }
  let moved = false
  try {
    // Settings offers any source, so an upgrade may hold it while this runs as a user flow.
    const result = await exit.lockNow(() =>
      runFrozenExit(
        refundedMoves(session),
        runtime,
        channel,
        (progress) => {
          moved = true
          onBatch?.(progress)
        },
        recipient,
      ),
    )
    if (!result.hashes.length) throw new Error(copy.nothingToRefund)
    return result
  } finally {
    // The old version holds less now: Home and Withdraw read it again.
    if (moved) noteOldVersionWithdrawn()
  }
}
