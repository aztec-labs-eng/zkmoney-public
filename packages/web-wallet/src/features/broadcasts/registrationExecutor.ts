/**
 * Builds a registration's broadcast for the ledger: the session's own payload while its claim is
 * live, else a rebuild once the wallet is unlocked.
 */
import {
  BroadcastAbandoned,
  BroadcastDeferred,
  isTerminalRegistrationPhase,
  rebuildRegistrationBroadcast,
  recordRegistrationBroadcastSent,
  type BroadcastExecutor,
  type BroadcastJob,
  type PendingRegistrationRecord,
} from "@obsidion/front-core"
import { ContractService, type ObsidionWallet } from "@obsidion/sdk"
import type { WebWalletConfig } from "../../config/env"
import { buildRetrySignDeps } from "../onboarding/oxideOnboarding"
import { registrationBroadcastSeen, unlockedSessionKeys } from "../onboarding/registrationResume"
import { rememberReissuedClaim } from "../onboarding/registrationTerms"
import { buildWebDetectionDeps, getPendingStore } from "../onboarding/webRegistration"
import { createWebRegistrationBroadcaster } from "../onboarding/webRegistrationBroadcast"
import { WAITING_FOR_UNLOCK, WAIT_MS, freshPayloads, payloadDeadlineMs } from "./broadcasts"

export function registrationExecutor(
  wallet: ObsidionWallet,
  config: WebWalletConfig,
): BroadcastExecutor {
  const recordOf = (job: BroadcastJob) =>
    job.source.type === "registration" ? getPendingStore().get(job.source.account) : null

  /** The broadcast for a record whose session payload is gone: re-derived and re-signed. */
  const rebuild = async (
    record: PendingRegistrationRecord,
    keys: NonNullable<Awaited<ReturnType<typeof unlockedSessionKeys>>>,
  ) => {
    const signDeps = await buildRetrySignDeps(record.tag, keys, config)
    const { accountService } = signDeps
    const result = await rebuildRegistrationBroadcast(await buildWebDetectionDeps(config), record, {
      ...signDeps,
      accountService: {
        // A re-issued claim carries a new hold, and the stored terms follow it.
        signDomain: async (...args: Parameters<typeof accountService.signDomain>) => {
          const claim = await accountService.signDomain(...args)
          rememberReissuedClaim(record, claim)
          return claim
        },
      },
    })
    if (result.kind === "payload") return result.payload
    if (result.kind === "wait") throw new BroadcastDeferred(Date.now() + result.ms, result.reason)
    throw new BroadcastAbandoned(
      result.kind === "spent"
        ? "This registration's broadcast was already spent"
        : "The registration ended",
    )
  }

  return {
    landed: async (job) => {
      const record = recordOf(job)
      if (!record) return false
      return registrationBroadcastSeen({ ...record, sipaAddress: job.address }, config, wallet)
    },
    send: async (job, attempt) => {
      const record = recordOf(job)
      if (!record || isTerminalRegistrationPhase(record.phase))
        throw new BroadcastAbandoned("The registration ended")
      // An address the registration moved off (a refund at the earned price) is recovered, not
      // swept, and a predecessor that spent the rail left nothing to publish.
      if (record.sipaAddress.toLowerCase() !== job.address)
        throw new BroadcastAbandoned("The registration moved to another address")
      if (record.replaced?.broadcastSpent)
        throw new BroadcastAbandoned("This registration's broadcast was already spent")
      const keys = await unlockedSessionKeys(wallet)
      const owned =
        keys?.account.getAddress().toString().toLowerCase() === record.l2Address.toLowerCase()
      if (!keys || !owned) throw new BroadcastDeferred(Date.now() + WAIT_MS, WAITING_FOR_UNLOCK)
      // A cached payload whose claim or signed terms have lapsed would be refused at the sweep.
      const cached = freshPayloads.get(job.address)
      const fresh = cached && payloadDeadlineMs(cached) > Date.now() + WAIT_MS ? cached : undefined
      const payload = fresh ?? (await rebuild(record, keys))
      const broadcast = createWebRegistrationBroadcaster({
        wallet,
        account: keys.account,
        contractService: ContractService.getInstance(),
        config,
        handle: record.tag,
      })
      const txHash = await broadcast(payload, attempt)
      freshPayloads.delete(job.address)
      await recordRegistrationBroadcastSent(getPendingStore(), record.account, job.address)
      return txHash
    },
    // A broadcast found on chain, e.g. one an earlier page sent before it could stamp the record.
    onLanded: async (job) => {
      freshPayloads.delete(job.address)
      if (job.source.type !== "registration") return
      const record = getPendingStore().get(job.source.account)
      if (record && !record.broadcast)
        await recordRegistrationBroadcastSent(getPendingStore(), record.account, job.address)
    },
  }
}
