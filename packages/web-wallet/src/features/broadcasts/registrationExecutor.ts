/**
 * Builds a registration's broadcast for the ledger, and for the ticket claim that sends it: the
 * session's own payload while its claim is live, else a rebuild once the wallet is unlocked.
 */
import {
  BROADCAST_WAIT_MS,
  BroadcastDeferred,
  WalletError,
  isTerminalRegistrationPhase,
  rebuildRegistrationBroadcast,
  registrationAt,
  type AccountRecord,
  type BroadcastExecutor,
  type BroadcastJobOf,
  type PendingRegistrationRecord,
  type RegistrationBroadcastPayload,
  type Service,
} from "@obsidion/front-core"
import type { ContractService, ObsidionAccount, ObsidionWallet } from "@obsidion/sdk"
import type { WebWalletConfig } from "../../config/env"
import type { SponsorParts } from "../../session/session"
import { buildRetrySignDeps } from "../registration/registrationDeps"
import { registrationBroadcastSeen, unlockedSessionKeys } from "../registration/registrationResume"
import { rememberReissuedClaim } from "../registration/registrationTerms"
import {
  buildWebDetectionDeps,
  knownRegistrations,
  type DetectionStores,
} from "../registration/webRegistration"
import { createWebRegistrationBroadcaster } from "../registration/webRegistrationBroadcast"

/** When the sweep stops accepting the payload: its claim's deadline, or its signed terms' if sooner. */
export function payloadDeadlineMs(payload: RegistrationBroadcastPayload): number {
  const claim = payload.domainAuth.deadline
  const terms = payload.signedTerms.deadline
  return Number(terms > 0n && terms < claim ? terms : claim) * 1000
}

/** Payloads a session just signed, by lowercase address, so the first attempt needs no re-sign. */
export type RegistrationPayloads = Map<string, RegistrationBroadcastPayload>

/** What a session's registration broadcasts read: the payloads it signed, and its stores. */
export interface RegistrationBroadcastStores extends DetectionStores, SponsorParts {
  registrationPayloads: RegistrationPayloads
  accountRecord: Pick<AccountRecord, "get"> | null
}

/**
 * Owe a registration's broadcast. `payload` is the session's own, so the first attempt reuses it;
 * `now` drops a backoff, for the user's own retry.
 */
export async function oweRegistrationBroadcast(
  session: Pick<RegistrationBroadcastStores, "registrationPayloads" | "sipaDeposits">,
  wakeBroadcasts: () => void,
  record: Pick<PendingRegistrationRecord, "account" | "sipaAddress">,
  opts: { payload?: RegistrationBroadcastPayload; now?: boolean } = {},
): Promise<void> {
  const address = record.sipaAddress.toLowerCase()
  if (opts.payload) session.registrationPayloads.set(address, opts.payload)
  await session.sipaDeposits.oweBroadcast(address, {
    kind: "registration",
    source: { type: "registration", account: record.account },
  })
  if (opts.now) await session.sipaDeposits.apply(address, { type: "broadcastRetry" })
  wakeBroadcasts()
}

/** The broadcast for a record whose session payload is gone: re-derived and re-signed. */
async function rebuild(
  config: WebWalletConfig,
  networkId: string,
  record: PendingRegistrationRecord,
  keys: NonNullable<Awaited<ReturnType<typeof unlockedSessionKeys>>>,
  session: RegistrationBroadcastStores,
): Promise<RegistrationBroadcastPayload> {
  const signDeps = await buildRetrySignDeps(
    session.signup.grantToken(record.tag),
    keys,
    session.page,
    networkId,
    session.sipaDeposits,
    session.accountRecord,
  )
  const { accountService } = signDeps
  const deps = await buildWebDetectionDeps(config, session)
  const result = await rebuildRegistrationBroadcast(deps, record, {
    ...signDeps,
    accountService: {
      // A re-issued claim carries a new hold, and the stored terms follow it.
      signDomain: async (...args: Parameters<typeof accountService.signDomain>) => {
        const claim = await accountService.signDomain(...args)
        rememberReissuedClaim(session.registrations, record, claim)
        return claim
      },
    },
  })
  if (result.kind === "payload") return result.payload
  if (result.kind === "wait") throw new BroadcastDeferred(Date.now() + result.ms)
  throw new WalletError("deposit.addressRetired", result.kind)
}

/**
 * What publishes a registration's address, and the unlocked account that sends it: the session's
 * own payload while its claim and terms hold, else one rebuilt and re-signed. Throws
 * `BroadcastDeferred` while the wallet is locked or the rebuild must wait, and `BroadcastAbandoned`
 * when nothing is left to publish.
 */
export async function registrationBroadcastPayload(
  wallet: ObsidionWallet,
  config: WebWalletConfig,
  record: PendingRegistrationRecord,
  session: RegistrationBroadcastStores,
): Promise<{ payload: RegistrationBroadcastPayload; account: ObsidionAccount }> {
  if (isTerminalRegistrationPhase(record.phase))
    throw new WalletError("deposit.addressRetired", "registration ended")
  if (record.replaced?.broadcastSpent)
    throw new WalletError("deposit.addressRetired", "registration broadcast spent")
  const keys = await unlockedSessionKeys(session, wallet)
  const owned =
    keys?.account.getAddress().toString().toLowerCase() === record.l2Address.toLowerCase()
  if (!keys || !owned) throw new BroadcastDeferred(Date.now() + BROADCAST_WAIT_MS, "unlock")
  // A cached payload whose claim or signed terms have lapsed would be refused at the sweep.
  const cached = session.registrationPayloads.get(record.sipaAddress.toLowerCase())
  const fresh =
    cached && payloadDeadlineMs(cached) > Date.now() + BROADCAST_WAIT_MS ? cached : undefined
  return {
    payload: fresh ?? (await rebuild(config, wallet.networkId, record, keys, session)),
    account: keys.account,
  }
}

export function registrationExecutor(
  wallet: ObsidionWallet,
  config: WebWalletConfig,
  session: RegistrationBroadcastStores,
  contractService: Service<ContractService>,
): BroadcastExecutor<BroadcastJobOf<"registration">> {
  const recordOf = (job: BroadcastJobOf<"registration">) =>
    registrationAt(knownRegistrations(session.registrations), job.address)

  return {
    landed: async (job) => {
      const record = recordOf(job)
      if (!record) return false
      return registrationBroadcastSeen(
        session.sipaDeposits,
        record,
        session.page,
        wallet,
        job.republishSince,
      )
    },
    send: async (job, attempt) => {
      const record = recordOf(job)
      // An address the registration moved off (a refund at the earned price) closed as replaced:
      // it is recovered, not swept.
      if (!record) throw new WalletError("deposit.addressRetired", "registration ended")
      const { payload, account } = await registrationBroadcastPayload(
        wallet,
        config,
        record,
        session,
      )
      const broadcast = createWebRegistrationBroadcaster({
        wallet,
        account,

        contractService: await contractService.ready(),
        config,
        handle: record.tag,
        session,
      })
      const txHash = await broadcast(payload, attempt)
      session.registrationPayloads.delete(job.address)
      await session.registrations.broadcastSent(job.address)
      return txHash
    },
    // A broadcast found on chain, e.g. one an earlier page sent before it could stamp the record.
    onLanded: async (job) => {
      session.registrationPayloads.delete(job.address)
      if (recordOf(job)?.broadcast === false) await session.registrations.broadcastSent(job.address)
    },
  }
}
