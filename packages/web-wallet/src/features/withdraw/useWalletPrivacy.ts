import { useMemo } from "react"
import type { Address } from "viem"
import {
  derived,
  memoryStore,
  useStore,
  type QueryState,
  type ReadonlyStore,
} from "@obsidion/front-core"
import { useSession } from "../../session/session"
import { isEtherfiContact, type SavedL1Wallet } from "../../session/savedL1Wallets"
import { localVerdict, withdrawalsTo } from "./addressFacts"
import type { AddressFacts, L1AddressActivity } from "./addressFacts"
import { privacyLevel, privacyRing } from "./privacyRing"
import type { PrivacyLevel, PrivacyRing } from "./privacyRing"
import { useWithdrawals } from "./useWithdrawals"

/** One wallet's ring, its level, and the public name behind its identity segment. */
export interface WalletPrivacy {
  ring: PrivacyRing
  level: PrivacyLevel
  /** ether.fi Cash: the app names it. */
  etherfi: boolean
  /** Its ENS name. */
  ensName?: string
  /** How many times this wallet withdrew to it. */
  withdrawals: number
  /** Its ETH on L1; undefined when the read did not answer. */
  balance?: bigint
}

/** Rates one address from its facts; an ether.fi address is named by the app. */
export function ratePrivacy(facts: AddressFacts, etherfi: boolean): WalletPrivacy {
  const { local, nonce, balance, withdrawals } = facts
  const activity =
    nonce === undefined || balance === undefined ? undefined : nonce > 0 || balance > 0n
  const ensName = facts.ensName || undefined
  const ring = privacyRing({ local, activity, named: etherfi || !!ensName })
  return { ring, level: privacyLevel(ring), etherfi, ensName, withdrawals, balance }
}

/**
 * Rates each saved wallet from its L1 activity and, but for an ether.fi address, its ENS name. Each
 * rating shows once both read; a new mount reads the activity again.
 */
export function useWalletPrivacy(wallets: SavedL1Wallet[]): Map<string, WalletPrivacy> {
  const { page } = useSession()
  const { records } = useWithdrawals()
  const asked = wallets.map((w) => `${w.address}:${isEtherfiContact(w.entry)}`).join(",")
  const reads = useMemo(() => {
    const entries = asked
      .split(",")
      .filter(Boolean)
      .map((key) => {
        const [address, etherfi] = key.split(":") as [Address, string]
        return derived(
          [page.l1AddressActivity(address), etherfi === "true" ? ETHERFI_NAME : page.chain.ensName(address)],
          (activity, name) => ({ activity, name }),
        )
      })
    return derived(entries, (...states: readonly WalletReads[]) => states)
  }, [page, asked])
  const states = useStore(reads)
  return useMemo(() => {
    const contacts = wallets.map((w) => w.entry)
    return new Map(
      wallets.flatMap((wallet, i): [string, WalletPrivacy][] => {
        const read = states[i]
        if (read?.activity.status !== "ready" || read.name.status === "pending") return []
        const lower = wallet.address.toLowerCase()
        const facts = {
          ...read.activity.value,
          ensName: read.name.status === "ready" ? read.name.value : undefined,
          local: localVerdict(lower, records, contacts),
          withdrawals: withdrawalsTo(lower, records),
          localRead: true,
        }
        return [[lower, ratePrivacy(facts, isEtherfiContact(wallet.entry))]]
      }),
    )
  }, [wallets, records, states])
}

interface WalletReads {
  activity: QueryState<L1AddressActivity>
  name: QueryState<string | null>
}

/** An ether.fi address reads no name: the app names it. */
const ETHERFI_NAME: ReadonlyStore<QueryState<string | null>> = memoryStore<
  QueryState<string | null>
>({ status: "ready", value: null, refreshing: false }).readonly
