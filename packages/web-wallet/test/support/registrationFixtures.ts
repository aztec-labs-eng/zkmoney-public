/** One registration as the stores, the claim server and the tab's stash hold it. */
import { isAddress, type Address, type Hex } from "viem"
import type { NameClaimResponse, SignedTermsResponse } from "@obsidion/core/types"
import {
  currentRegistration,
  encodeRecord,
  latestRegistration,
  loadRecords,
  registrationAt,
  registrationId,
  type PendingRegistrationRecord,
  type RegistrationTerms,
  type SipaDeposit,
} from "@obsidion/front-core"
import { RANDOM } from "./registrationPrices"
import type { TicketSignupStash } from "../../src/features/paylink/claimStash"
import { openedSession } from "../../src/session/session"
import { openTestSession } from "./session"
import { seedSipaDeposit } from "./sipaDeposits"

export const DAI = 10n ** 18n
/** DAI to the cent, in base units. */
export const dai = (n: number) => BigInt(Math.round(n * 100)) * 10n ** 16n
/** 2100-01-01, unix seconds: a deadline no test outlives. */
export const FAR_DEADLINE = "4102444800"

export const ACCOUNT = "0x00000000000000000000000000000000000000f1"
export const L2_ADDRESS: Hex = `0x${"22".repeat(32)}`
const NAME_HASH: Hex = `0x${"11".repeat(32)}`
export const SIPA = "0x00000000000000000000000000000000000000c3"
const TOKEN: Hex = "0x00000000000000000000000000000000000000d4"
/** The fragment a ticket-funded registration is bound to. */
const PAYLINK_FRAGMENT = "paylink-frag"

export const pendingRecord = (
  over: Partial<PendingRegistrationRecord> = {},
): PendingRegistrationRecord => ({
  account: ACCOUNT,
  tag: "taga",
  nameHash: NAME_HASH,
  l2Address: L2_ADDRESS,
  l1ChainId: 11155111,
  sipaAddress: SIPA,
  fee: String(RANDOM.fee),
  beneficiary: "0x00000000000000000000000000000000000000b5",
  depositToken: TOKEN,
  broadcast: true,
  phase: "awaiting_deposit",
  retries: 0,
  startTime: Date.now(),
  ...over,
})

/** The earned schedule: the tag price waived, the relayer's 0.5 fee over a 4.5 minimum. */
export const earnedTerms = (over: Partial<SignedTermsResponse> = {}): SignedTermsResponse => ({
  fee: String(RANDOM.fee),
  minDeposit: String(RANDOM.min),
  nonce: "1",
  deadline: FAR_DEADLINE,
  signature: "0x00",
  reduced: true,
  ticket: false,
  ...over,
})

/** A NameClaim whose hold ends with it. */
export function nameClaim(over: Partial<NameClaimResponse> = {}): NameClaimResponse {
  const deadline = over.deadline ?? FAR_DEADLINE
  return { signature: "0x", nonce: "1", deadline, hold: { deadline }, ...over }
}

/** Stored terms for one registration, live for two more hours. */
export const registrationTerms = (over: Partial<RegistrationTerms> = {}): RegistrationTerms => ({
  deadline: Math.floor(Date.now() / 1000) + 7200,
  ...over,
})

/** Stored terms a paylink's golden ticket bought, bound to `PAYLINK_FRAGMENT`. */
export const ticketBoundTerms = (over: Partial<RegistrationTerms> = {}): RegistrationTerms =>
  registrationTerms({
    fee: String(dai(0.5)),
    minDeposit: "0",
    feeWaived: true,
    paylinkFunded: true,
    paylinkId: `id:${PAYLINK_FRAGMENT}`,
    ...over,
  })

/** The marker a ticket signup stashes on its tab. */
export const ticketSignupStash = (over: Partial<TicketSignupStash> = {}): TicketSignupStash => ({
  fragment: PAYLINK_FRAGMENT,
  threshold: String(2n * DAI),
  schedule: { fee: String(dai(0.5)), minDeposit: "0" },
  ...over,
})

/** Seeds the rail record the registration's deposit address keeps. */
export async function seedRegistrationRail(
  record: PendingRegistrationRecord,
  patch: Partial<SipaDeposit> & Pick<SipaDeposit, "phase">,
  over: Partial<Omit<SipaDeposit, "sipaAddress" | "phase">> = {},
): Promise<void> {
  const sipa = record.sipaAddress
  if (!isAddress(sipa)) throw new Error(`not an address: ${sipa}`)
  const token: Address = record.depositToken
  await seedSipaDeposit({
    sipaAddress: sipa,
    networkId: "0xnet",
    recipientL2Address: record.l2Address,
    tokenAddress: token,
    tokenSymbol: "DAI",
    l1ChainId: record.l1ChainId,
    messageSecret: record.nameHash,
    recoveryAddress: record.account,
    recipientHash: record.nameHash,
    amount: "15",
    startTime: 1,
    intent: "registration",
    ...over,
    ...patch,
  })
}

/** The open session; opens the namespace's session when none is. */
const sessionNow = () => openedSession.get() ?? openTestSession()

/**
 * Saves `record` as is, past every fence the transition keeps: a fixture's state, not an event a
 * writer sends. Resolves once the session's view holds it.
 */
export async function seedRegistration(record: PendingRegistrationRecord): Promise<void> {
  const { db, registrations } = sessionNow()
  await registrations.ready
  await db.write(async (w) =>
    w.put(`acct/registrations/${registrationId(record.sipaAddress)}`, encodeRecord(record)),
  )
}

/** The session's record at `sipa`, once its records load. */
export async function storedRegistration(sipa: string = SIPA) {
  return registrationAt(await loadRecords(sessionNow().registrations.view), sipa)
}

/**
 * One account's record as suites written against an account-keyed store seed it: `upsert` lays a
 * patch over the account's newest record. A new address replaces the old one, which stays closed.
 */
export const accountRecords = {
  current(): PendingRegistrationRecord | null {
    return currentRegistration(sessionNow().registrations.view.get().records)
  },
  get(account: string): PendingRegistrationRecord | null {
    return latestRegistration(sessionNow().registrations.view.get().records, account)
  },
  async upsert(
    account: string,
    patch: Partial<PendingRegistrationRecord>,
    base?: Omit<PendingRegistrationRecord, "account">,
  ): Promise<PendingRegistrationRecord> {
    const current = accountRecords.get(account)
    const moved =
      current !== null &&
      registrationId(current.sipaAddress) !==
        registrationId(patch.sipaAddress ?? current.sipaAddress)
    const next = {
      ...(current ?? base),
      ...patch,
      account,
      ...(moved ? { startTime: current.startTime + 1 } : {}),
    } as PendingRegistrationRecord
    const { db, registrations } = sessionNow()
    await registrations.ready
    const put = (r: PendingRegistrationRecord) =>
      [`acct/registrations/${registrationId(r.sipaAddress)}`, encodeRecord(r)] as const
    await db.write(async (w) => {
      if (moved) w.put(...put({ ...current, phase: "replaced", endTime: Date.now() }))
      w.put(...put(next))
    })
    return next
  },
}
