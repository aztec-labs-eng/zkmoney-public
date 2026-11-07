/**
 * Builds a registration's broadcast for the ledger, and for the ticket claim that sends it: the
 * session's own payload while its claim is live, else a rebuild once the wallet is unlocked.
 */
import {
  BROADCAST_WAIT_MS,
  BroadcastDeferred,
  WalletError,
  isTerminalRegistrationPhase,
  readyValue,
  rebuildRegistrationBroadcast,
  registrationAt,
  type AccountRecord,
  type BroadcastExecutor,
  type BroadcastJobOf,
  type PendingRegistrationRecord,
  type RegistrationBroadcastPayload,
  type Resource,
} from "@obsidion/front-core"
import type { ContractService, ObsidionAccount, ObsidionWallet } from "@obsidion/sdk"
import type { WebWalletConfig } from "../../config/env"
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
export interface RegistrationBroadcastStores extends DetectionStores {
  registrationPayloads: RegistrationPayloads
  accountRecord: Pick<AccountRecord, "get"> | null
}

/**
 * Owe a registration's broadcast. `payload` is the session's own, so the first attempt reuses it;
 * `now` drops a backoff, for the user's own retry.
 */
export async function oweRegistrationBroadcast(
  own: Pick<RegistrationBroadcastStores, "registrationPayloads" | "sipaDeposits">,
  wakeBroadcasts: () => void,
  record: Pick<PendingRegistrationRecord, "account" | "sipaAddress">,
  opts: { payload?: RegistrationBroadcastPayload; now?: boolean } = {},
): Promise<void> {
  const address = record.sipaAddress.toLowerCase()
  if (opts.payload) own.registrationPayloads.set(address, opts.payload)
  await own.sipaDeposits.oweBroadcast(address, {
    kind: "registration",
    source: { type: "registration", account: record.account },
  })
  if (opts.now) await own.sipaDeposits.apply(address, { type: "broadcastRetry" })
  wakeBroadcasts()
}

/** The broadcast for a record whose session payload is gone: re-derived and re-signed. */
async function rebuild(
  config: WebWalletConfig,
  networkId: string,
  record: PendingRegistrationRecord,
  keys: NonNullable<Awaited<ReturnType<typeof unlockedSessionKeys>>>,
  own: RegistrationBroadcastStores,
): Promise<RegistrationBroadcastPayload> {
  const signDeps = await buildRetrySignDeps(
    own.signup.grantToken(record.tag),
    keys,
    config,
    networkId,
    own.sipaDeposits,
    own.accountRecord,
  )
  const { accountService } = signDeps
  const deps = await buildWebDetectionDeps(config, own)
  const result = await rebuildRegistrationBroadcast(deps, record, {
    ...signDeps,
    accountService: {
      // A re-issued claim carries a new hold, and the stored terms follow it.
      signDomain: async (...args: Parameters<typeof accountService.signDomain>) => {
        const claim = await accountService.signDomain(...args)
        rememberReissuedClaim(own.registrations, record, claim)
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
  own: RegistrationBroadcastStores,
): Promise<{ payload: RegistrationBroadcastPayload; account: ObsidionAccount }> {
  if (isTerminalRegistrationPhase(record.phase))
    throw new WalletError("deposit.addressRetired", "registration ended")
  if (record.replaced?.broadcastSpent)
    throw new WalletError("deposit.addressRetired", "registration broadcast spent")
  const keys = await unlockedSessionKeys(wallet)
  const owned =
    keys?.account.getAddress().toString().toLowerCase() === record.l2Address.toLowerCase()
  if (!keys || !owned) throw new BroadcastDeferred(Date.now() + BROADCAST_WAIT_MS, "unlock")
  // A cached payload whose claim or signed terms have lapsed would be refused at the sweep.
  const cached = own.registrationPayloads.get(record.sipaAddress.toLowerCase())
  const fresh =
    cached && payloadDeadlineMs(cached) > Date.now() + BROADCAST_WAIT_MS ? cached : undefined
  return {
    payload: fresh ?? (await rebuild(config, wallet.networkId, record, keys, own)),
    account: keys.account,
  }
}

export function registrationExecutor(
  wallet: ObsidionWallet,
  config: WebWalletConfig,
  own: RegistrationBroadcastStores,
  contractService: Resource<ContractService>,
): BroadcastExecutor<BroadcastJobOf<"registration">> {
  const recordOf = (job: BroadcastJobOf<"registration">) =>
    registrationAt(knownRegistrations(own.registrations), job.address)

  return {
    landed: async (job) => {
      const record = recordOf(job)
      if (!record) return false
      return registrationBroadcastSeen(own.sipaDeposits, record, config, wallet, job.republishSince)
    },
    send: async (job, attempt) => {
      const record = recordOf(job)
      // An address the registration moved off (a refund at the earned price) closed as replaced:
      // it is recovered, not swept.
      if (!record) throw new WalletError("deposit.addressRetired", "registration ended")
      const { payload, account } = await registrationBroadcastPayload(wallet, config, record, own)
      const broadcast = createWebRegistrationBroadcaster({
        wallet,
        account,
        contractService: await readyValue(contractService),
        config,
        handle: record.tag,
        nameClaims: own.nameClaims,
      })
      const txHash = await broadcast(payload, attempt)
      own.registrationPayloads.delete(job.address)
      await own.registrations.broadcastSent(job.address)
      return txHash
    },
    // A broadcast found on chain, e.g. one an earlier page sent before it could stamp the record.
    onLanded: async (job) => {
      own.registrationPayloads.delete(job.address)
      if (recordOf(job)?.broadcast === false) await own.registrations.broadcastSent(job.address)
    },
  }
}
