/**
 * What the chain and this wallet know about one L1 address. The fresh verdict and the privacy
 * rating both derive from it.
 */
import type { Address, PublicClient } from "viem"
import { useMemo } from "react"
import {
  derived,
  memoryStore,
  useLookup,
  useStore,
  type QueryFactory,
  type QueryState,
  type ReadonlyStore,
  type RecordSet,
} from "@obsidion/front-core"
import type {
  BridgeInRecord,
  Contact,
  Loaded,
  SipaDeposit,
  WithdrawalRecord,
} from "@obsidion/front-core"
import { useSession } from "../../session/session"

/** Each chain fact is undefined when its read did not answer. */
export interface AddressFacts {
  code?: boolean
  nonce?: number
  balance?: bigint
  /** Undefined when not read or the read did not answer; null when there is no name. */
  ensName?: string | null
  /** What this wallet already did with the address. */
  local: { kind: "linked-deposit" | "withdrew-before" } | null
  /** Withdrawals this wallet sent to it. */
  withdrawals: number
  /** Every local read answered. */
  localRead: boolean
}

/** An address's activity on the L1; each fact is undefined when its read did not answer. */
export type L1AddressActivity = Pick<AddressFacts, "code" | "nonce" | "balance">

export type AddressFactsRead =
  | { kind: "idle" }
  | { kind: "checking" }
  | { kind: "timeout" }
  | { kind: "read"; facts: AddressFacts }

const DEBOUNCE_MS = 300

const settled = <T>(result: PromiseSettledResult<T>): T | undefined =>
  result.status === "fulfilled" ? result.value : undefined

/** A tombstoned contact is revived by activity newer than its removal. */
const isLiveL1Contact = (contact: Contact): boolean => {
  const w = contact.l1Wallet
  return (
    !!w &&
    contact.addressKind === "ethereum-l1" &&
    (!w.deletedAt || (w.lastUsedAt ?? 0) > w.deletedAt)
  )
}

/**
 * Withdrawals this wallet sent to `target`. Registration and migration burns pay the wallet's own
 * SIPA, not a destination the user chose.
 */
export const withdrawalsTo = (target: string, withdrawals: readonly WithdrawalRecord[]) =>
  withdrawals.filter(
    (r) => !r.intent && r.phase !== "failed" && r.recipient.toLowerCase() === target,
  ).length

/** Who funded this wallet's deposits, lowercase and sorted; `read` once the deposits load. */
export interface DepositFunders {
  read: boolean
  addresses: readonly string[]
}

/**
 * A bridge fill's sender is its relayer, not the user: the bridge-in that paid this wallet names
 * who sent it.
 */
export const selectDepositFunders = (
  { records, loaded, failed }: RecordSet<SipaDeposit>,
  bridgeIns: Loaded<BridgeInRecord>,
): DepositFunders => ({
  read: loaded && !failed && bridgeIns.hydrated,
  addresses: [
    ...new Set(
      [
        ...records.flatMap((d) =>
          d.funding !== "bridge" && d.fundingFromAddress ? [d.fundingFromAddress] : [],
        ),
        ...bridgeIns.records.flatMap((r) =>
          !r.pays && (r.status === "pending" || r.status === "filled") ? [r.depositor] : [],
        ),
      ].map((address) => address.toLowerCase()),
    ),
  ].sort(),
})

export const sameFunders = (a: DepositFunders, b: DepositFunders): boolean =>
  a.read === b.read &&
  a.addresses.length === b.addresses.length &&
  a.addresses.every((address, i) => address === b.addresses[i])

/** Who funded the session's deposits, from its deposits and bridge-ins. */
export function useDepositFunders(): DepositFunders {
  const { sipaDeposits, bridgeIns } = useSession()
  const funders = useMemo(
    () => derived([sipaDeposits.view, bridgeIns.list], selectDepositFunders),
    [sipaDeposits, bridgeIns],
  )
  return useStore(funders, (value) => value, sameFunders)
}

/** What this wallet already did with the address; the deposit link outranks a prior withdrawal. */
export function localVerdict(
  target: string,
  withdrawals: readonly WithdrawalRecord[],
  contacts: readonly Contact[],
  funders: readonly string[],
): AddressFacts["local"] {
  const provenance = contacts
    .filter((c) => c.address.toLowerCase() === target && isLiveL1Contact(c))
    .map((c) => c.l1Wallet!.provenance)
  if (provenance.includes("deposit-attested") || funders.includes(target))
    return { kind: "linked-deposit" }
  if (provenance.includes("saved-recipient")) return { kind: "withdrew-before" }
  return withdrawalsTo(target, withdrawals) > 0 ? { kind: "withdrew-before" } : null
}

/** Each address's nonce, ETH balance and code on the L1, read again on every read. */
export function l1AddressActivities(
  query: QueryFactory,
  client: () => Pick<PublicClient, "getTransactionCount" | "getBalance" | "getCode">,
) {
  return query<[Address], L1AddressActivity>("l1AddressActivity", {
    load: async (address) => {
      const l1 = client()
      const [nonce, balance, code] = await Promise.allSettled([
        l1.getTransactionCount({ address }),
        l1.getBalance({ address }),
        l1.getCode({ address }),
      ])
      const codeRead = settled(code)
      return {
        code: code.status === "fulfilled" ? !!codeRead && codeRead !== "0x" : undefined,
        nonce: settled(nonce),
        balance: settled(balance),
      }
    },
    stale: 0,
  })
}

/** The facts from the L1 activity, the ENS name and the wallet's own records. */
export function addressFacts(
  address: Address,
  activity: L1AddressActivity,
  ensName: string | null | undefined,
  withdrawals: { records: readonly WithdrawalRecord[]; read: boolean },
  contacts: { records: readonly Contact[]; read: boolean },
  funders: DepositFunders,
): AddressFacts {
  const target = address.toLowerCase()
  return {
    ...activity,
    ensName,
    local: localVerdict(target, withdrawals.records, contacts.records, funders.addresses),
    withdrawals: withdrawalsTo(target, withdrawals.records),
    localRead: withdrawals.read && contacts.read && funders.read,
  }
}

/** Whether the address reads as fresh, or what speaks against it. */
export type FreshAddressVerdict =
  | "fresh" // zero nonce, zero balance, no code, no local history
  | "history" // nonce or balance on L1
  | "contract" // the escrow pays ETH with a plain call, so a contract that rejects ETH strands it
  | "withdrew-before" // a withdrawal record or a saved-recipient L1 contact names it
  | "linked-deposit" // a deposit record or deposit-attested L1 contact: it funded the account
  | "unknown" // a read did not answer

/**
 * Precedence: contract, linked-deposit, withdrew-before, history, fresh. A read that failed cannot
 * rule anything out, so `fresh` needs every read, the wallet's own included, and `unknown`
 * covers a failed read with nothing else to say. What the other reads found still counts.
 */
export function verdictFromFacts(facts: AddressFacts): FreshAddressVerdict {
  if (facts.code) return "contract"
  if (facts.local) return facts.local.kind
  if ((facts.nonce ?? 0) > 0 || (facts.balance ?? 0n) > 0n) return "history"
  const answered =
    facts.code !== undefined &&
    facts.nonce !== undefined &&
    facts.balance !== undefined &&
    facts.localRead
  return answered ? "fresh" : "unknown"
}

const NO_CONTACTS: ReadonlyStore<RecordSet<Contact>> = memoryStore({
  records: [],
  loaded: true,
  failed: false,
}).readonly
const NO_NAME: ReadonlyStore<QueryState<string | null>> = memoryStore<QueryState<string | null>>({
  status: "pending",
}).readonly

/**
 * The facts for the address passed: `idle` while there is none, `checking` through the debounce
 * and the reads, and `timeout` once `waitMs` passes without an answer, until a late one lands.
 * `retry` reads again.
 */
export function useAddressFacts(
  address: Address | null,
  waitMs: number,
): AddressFactsRead & { retry(): void } {
  const session = useSession()
  const { page } = session
  const lookup = useLookup(address ?? undefined, page.l1AddressActivity, {
    delayMs: DEBOUNCE_MS,
    lateMs: waitMs,
  })
  const name = useStore(address ? page.chain.ensName(address) : NO_NAME)
  const withdrawals = useStore(session.withdrawals.list)
  const contacts = useStore(session.contacts?.view ?? NO_CONTACTS)
  const funders = useDepositFunders()
  const { retry } = lookup
  if (lookup.status === "idle" || !address) return { kind: "idle", retry }
  const named = name.status !== "pending"
  if (lookup.status === "answered" && named) {
    const facts = addressFacts(
      address,
      lookup.value,
      name.status === "ready" ? name.value : undefined,
      { records: withdrawals.records, read: withdrawals.hydrated },
      { records: contacts.records, read: contacts.loaded && !contacts.failed },
      funders,
    )
    return { kind: "read", facts, retry }
  }
  if (lookup.status === "failed" || (lookup.status === "waiting" && lookup.late)) {
    return { kind: "timeout", retry }
  }
  return { kind: "checking", retry }
}
