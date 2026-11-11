import {
  bestEffort,
  linkIdFor,
  loadRecords,
  task,
  TxInFlightError,
  userFlowActive,
  within,
  type BackupRotations,
  type OperationRecord,
  type Service,
  type Task,
} from "@obsidion/front-core"
import type { WebWalletConfig } from "../../config/env"
import { decodePaylinkInline } from "@obsidion/sdk"
import { claimVerdictNow } from "../actionGate"
import { retryableFailure } from "../operations/operations"
import {
  CLAIM_IO,
  claimFailureReason,
  retryable,
  showClaimFailure,
} from "./ClaimLinkSheet/claimFlow"
import { latestChainSeconds } from "./chainTime"
import { claimWaitSeconds, withExpiry } from "./claimWindow"
import type { Claims, ClaimsState } from "./claims"
import { peekClaimStash } from "./claimStash"
import { tabStash } from "../../platform/storage/tabStash"
import type { EmailClaimOwner } from "./emailClaim"
import { seededLink } from "./linkStatus"
import { linkClaimed, type PaylinkSession, type SponsoredPaylinkDeps } from "./sponsoredPaylink"
import type { ReadyPaylinkDeps } from "./sponsoredPaylink"
import { ticketSignupContinuation, type TicketActivation } from "./ticketContinuation"
import type { PaymentLink } from "./types"
import type { Session } from "../../session/session"

const TICKET_CLAIM_MS = 5_000

/**
 * What Home's automatic claim of a ticket link waits for before it starts: the claim window to
 * open, or the wallet and the link to be read. Nothing runs yet, so the bell has no row, and the
 * activation surfaces say this instead of claiming.
 */
export type AutoClaimHold = { claimableFrom: number } | "preparing"

/** What Home's own claim of a ticket signup's link does on a pass. */
export type TicketClaimGate =
  | { kind: "idle" }
  /**
   * Only the review's tap claims it: an email link's sign-in, a link that closed, or one whose
   * window cannot be read, which the claim itself decides.
   */
  | { kind: "tap" }
  | { kind: "hold"; hold: AutoClaimHold }
  | { kind: "claim" }

/** A ready signup's direct link claims once its window opens, so no try is spent on a revert. */
export function ticketClaimGate(i: {
  activation: TicketActivation["state"] | undefined
  link: PaymentLink | null
  chainNow: number | undefined
  open: boolean
}): TicketClaimGate {
  if (i.activation !== "ready" || !i.link) return { kind: "idle" }
  const link = withExpiry(i.link, i.chainNow)
  if (link.flavor !== "direct" || link.status !== "unclaimed" || link.claimableFrom == null)
    return { kind: "tap" }
  const wait = claimWaitSeconds(link.claimableFrom, i.chainNow)
  if (wait === undefined) return { kind: "hold", hold: "preparing" }
  if (wait > 0) return { kind: "hold", hold: { claimableFrom: link.claimableFrom } }
  return i.open ? { kind: "claim" } : { kind: "hold", hold: "preparing" }
}

/** What the activation surfaces show of Home's own claim of a ticket link. */
export type TicketClaimView =
  | { kind: "idle" }
  | { kind: "hold"; hold: AutoClaimHold }
  /** A claim of the link runs, or Home's starts on its next pass. */
  | { kind: "claiming" }
  /** Only the review's tap claims it: the gate asks for it, or the automatic claim ended. */
  | { kind: "tap" }

/** The link's key in `paylinks` and on its claims' operations; null for one that does not decode. */
export function claimLinkId(fragment: string): string | null {
  try {
    return linkIdFor(decodePaylinkInline(fragment))
  } catch {
    return null
  }
}

/**
 * The newest claim of the link failed, and no later try gets past that failure: its flow's code is
 * final, or the network turned the sent claim down. It holds across reloads: the claim's operation
 * keeps its failure. An interrupted claim sent nothing, and runs again.
 */
export function claimRefused(records: readonly OperationRecord[], linkId: string | null): boolean {
  let last: OperationRecord | undefined
  for (const r of records)
    if (r.kind === "paylink-claim" && r.payload.linkId === linkId)
      if (!last || r.startedAt > last.startedAt) last = r
  if (last?.state !== "failed") return false
  return last.cause === "dropped" || (!!last.failure && !retryableFailure(last.failure.code))
}

/**
 * The one view of the automatic claim, off its gate, the page's claims of `fragment`, and whether
 * a claim of the link failed for good.
 */
export function ticketClaimView(
  gate: TicketClaimGate,
  claims: Pick<ClaimsState, "running" | "declined">,
  fragment: string,
  refused: boolean,
): TicketClaimView {
  if (claims.running.has(fragment)) return { kind: "claiming" }
  if (refused || claims.declined.has(fragment) || gate.kind === "tap") return { kind: "tap" }
  if (gate.kind === "hold") return gate
  return gate.kind === "claim" ? { kind: "claiming" } : { kind: "idle" }
}

export type TicketClaimNeeds = {
  [K in "wallet" | "account" | "tokenService" | "teeSigner" | "contractService"]: Service<
    ReadyPaylinkDeps[K]
  >
}

/** What the task calls out to, bound late for the suites that mock these modules. */
export const TICKET_CLAIM_IO = {
  chainSeconds: ((...a) => latestChainSeconds(...a)) as typeof latestChainSeconds,
  /** No upgrade or balance move holds a claim. */
  open: async (own: Pick<Session, "page" | "backupRotations">, address: string) =>
    (await claimVerdictNow(own.page.config, address, own.backupRotations)) === "open",
  claim: (own: EmailClaimOwner, deps: SponsoredPaylinkDeps, fragment: string, link: PaymentLink) =>
    CLAIM_IO.claim(
      own,
      deps,
      fragment,
      link,
      () => undefined,
      true,
      Promise.resolve(),
      undefined,
      // Automatic: a retryable failure before its proof leaves no record.
      true,
    ),
  /** The link's note is spent, read now: this tab's earlier read never says so. */
  claimed: ((...a) => linkClaimed(...a)) as typeof linkClaimed,
  showFailure: showClaimFailure,
}

export function linkOf(config: WebWalletConfig, fragment: string): PaymentLink | null {
  try {
    return seededLink(config, fragment)
  } catch {
    return null
  }
}

/**
 * Home's own claim of the link that pays for this account's signup: the signup entered the wallet
 * as soon as its name was reserved, so the claim starts once the link's window opens and the bell
 * carries it. A failure a later try may get past backs off; any other, kept on the claim's
 * operation, ends the automatic claim across reloads, and the review, with why and its Claim, is
 * the retry. A link claimed elsewhere is read as such before any proof, and its review shows it.
 */
export function ticketClaim(
  needs: TicketClaimNeeds,
  own: EmailClaimOwner &
    PaylinkSession & {
      claims: Claims
      backupRotations: BackupRotations | null
    },
  io = TICKET_CLAIM_IO,
): Task {
  const { claims } = own
  const prover = own.page.prover.state
  return task("ticketClaim", {
    needs,
    every: TICKET_CLAIM_MS,
    // A claim in flight is the user's transaction: hiding the page never aborts it.
    whenHidden: TICKET_CLAIM_MS,
    backoff: { baseMs: TICKET_CLAIM_MS, maxMs: 60_000 },
    async run({ signal, wallet, account, contractService }) {
      const fragment = peekClaimStash(tabStash)
      if (!fragment) return
      const linkId = claimLinkId(fragment)
      const ended = () => {
        const { running, declined } = claims.state.get()
        const refused = claimRefused(own.operations.view.get().records, linkId)
        return running.has(fragment) || declined.has(fragment) || refused
      }
      const loaded = Promise.all([
        own.withdrawals.ready,
        loadRecords(own.registrations.view),
        loadRecords(own.operations.view),
      ])
      await within(loaded, "ticket claim records", { signal })
      if (ended()) return
      // Until the burns load, a signup's own burn is missing and its claim reads as still owed.
      if (!own.withdrawals.list.get().hydrated) return
      const address = account.getAddress().toString()
      const burns = () => own.withdrawals.list.get().records
      const signup = () =>
        ticketSignupContinuation(own, fragment, address, burns())?.activation.state
      const activation = signup()
      const link = linkOf(own.page.config, fragment)
      const ready = activation === "ready" && link !== null
      const chainNow = ready
        ? await bestEffort(
            "unknown",
            within(io.chainSeconds(wallet.node), "chain time", { signal }),
          )
        : undefined
      const open = ready && (await within(io.open(own, address), "claim verdict", { signal }))
      const gate = ticketClaimGate({ activation, link, chainNow, open })
      if (gate.kind !== "claim" || !link) return
      const deps = { rollupAddress: wallet.networkId, session: own }
      // This tab's earlier read never says claimed: a claim made elsewhere is read now, and the
      // review it opens reads it too.
      const read = { session: own, wallet, contractService, account }
      if (await within(io.claimed(read, fragment), "link claimed", { signal })) {
        claims.decline(fragment)
        return claims.request(fragment)
      }
      // Read again after the waits: the run may have ended, or another surface claimed the link. A
      // transaction the user runs goes first: the prover takes one at a time, so the claim waits for
      // a later pass.
      if (signal.aborted || ended() || signup() !== "ready" || userFlowActive(prover.get())) return
      claims.start(fragment)
      const claiming = io
        .claim(own, deps, fragment, link)
        .catch((e: unknown) => {
          // The claim reached the node, and the bell follows it.
          if (e instanceof TxInFlightError) return
          if (retryable(e)) throw e
          // The review, with its Claim, is the retry: Home is asked to show it, and the error sheet
          // opens over it. A failure stays on the claim's operation; a cancel leaves none.
          const reason = claimFailureReason(e)
          if (reason === undefined) claims.decline(fragment)
          else claims.failed(fragment, reason)
          claims.request(fragment)
          if (reason !== undefined) io.showFailure(e, reason)
          throw e
        })
        .finally(() => claims.end(fragment))
      await within(claiming, "ticket claim", { signal })
    },
  })
}
