/**
 * Whether a pasted address is an ether.fi Cash deposit address. ether.fi deploys each account's
 * deposit contract on Ethereum mainnet through its top-up factory when the account is created, and
 * the factory keeps the set of what it deployed, so the answer is one read, before the account has
 * ever received funds. The address is the same on every chain, so the mainnet factory answers for
 * every network this wallet runs on. A refusal blocks the sheet: funds sent elsewhere never reach
 * the Cash balance.
 */
import { useEffect, useState } from "react"
import { createPublicClient, http, parseAbi, type Address, type PublicClient } from "viem"
import { mainnet } from "viem/chains"
import { Network } from "@obsidion/core/constants"
import { getConfig } from "../../config/env"
import { l1PublicClient } from "../../config/oxideTuple"

/** ether.fi's TopUpSourceFactory on Ethereum mainnet, from cash-v3's `deployments/mainnet/1/deployments.json`. */
export const ETHERFI_TOPUP_FACTORY: Address = "0xF4e147Db314947fC1275a8CbB6Cde48c510cd8CF"

export const ETHERFI_TOPUP_FACTORY_ABI = parseAbi([
  "function isTopUpContract(address topUpContract) view returns (bool)",
])

export type EtherfiAddressVerdict =
  | { kind: "idle" } // no parseable address
  | { kind: "checking" }
  | { kind: "confirmed" } // the factory deployed it
  | { kind: "rejected" } // the factory did not
  | { kind: "unknown" } // the read did not answer

export interface EtherfiCheckDeps {
  client: Pick<PublicClient, "readContract">
}

const DEBOUNCE_MS = 300

export const ETHERFI_VERDICT_COPY: Record<
  Exclude<EtherfiAddressVerdict["kind"], "idle" | "checking">,
  { title: string; body: string; tone: "success" | "warning" | "error" }
> = {
  confirmed: {
    title: "ether.fi Cash address confirmed",
    body: "ether.fi's deposit factory on Ethereum deployed this address.",
    tone: "success",
  },
  rejected: {
    title: "This isn't an ether.fi Cash address",
    body:
      "ether.fi's deposit factory on Ethereum has no record of it. Funds sent here would not reach " +
      "a Cash balance. Copy the address from ether.fi's share-address page.",
    tone: "error",
  },
  unknown: {
    title: "Couldn't confirm this is an ether.fi address",
    body: "The check did not finish. Make sure the address came from ether.fi before you continue.",
    tone: "warning",
  },
}

export async function checkEtherfiAddress(
  address: Address,
  deps: EtherfiCheckDeps,
): Promise<EtherfiAddressVerdict> {
  const deployed = await deps.client.readContract({
    address: ETHERFI_TOPUP_FACTORY,
    abi: ETHERFI_TOPUP_FACTORY_ABI,
    functionName: "isTopUpContract",
    args: [address],
  })
  return { kind: deployed ? "confirmed" : "rejected" }
}

/** Where a build whose L1 is not mainnet asks; serves browsers from any origin. */
export const PUBLIC_MAINNET_RPC_URL = "https://ethereum-rpc.publicnode.com"

/**
 * The mainnet client to ask: the wallet's own L1 client on mainnet, else a mainnet RPC of its own,
 * since a testnet or sandbox build's L1 client points at another chain.
 * `VITE_ETHEREUM_MAINNET_RPC_URL` names that RPC; the public one stands in otherwise.
 */
export function etherfiFactoryClient(): Pick<PublicClient, "readContract"> {
  const config = getConfig()
  if (config.network === Network.MAINNET) return l1PublicClient(config)
  const url = import.meta.env.VITE_ETHEREUM_MAINNET_RPC_URL || PUBLIC_MAINNET_RPC_URL
  return createPublicClient({ chain: mainnet, transport: http(url, { timeout: 15_000 }) })
}

const liveDeps = (): EtherfiCheckDeps => ({ client: etherfiFactoryClient() })

/**
 * The verdict for the address in the field: `idle` while there is none, `checking` through the
 * debounce and the read, and a result only for the address still there. With `waitMs`, a read
 * still running by then reads `unknown` until its answer lands.
 */
export function useEtherfiAddressVerdict(
  address: Address | null,
  waitMs?: number,
): EtherfiAddressVerdict {
  const [verdict, setVerdict] = useState<EtherfiAddressVerdict>({ kind: "idle" })

  useEffect(() => {
    if (!address) {
      setVerdict({ kind: "idle" })
      return
    }
    let active = true
    setVerdict({ kind: "checking" })
    const timer = setTimeout(() => {
      checkEtherfiAddress(address, liveDeps())
        .catch((): EtherfiAddressVerdict => ({ kind: "unknown" }))
        .then((result) => {
          if (active) setVerdict(result)
        })
    }, DEBOUNCE_MS)
    const cap =
      waitMs &&
      setTimeout(() => setVerdict((v) => (v.kind === "checking" ? { kind: "unknown" } : v)), waitMs)
    return () => {
      active = false
      clearTimeout(timer)
      clearTimeout(cap)
    }
  }, [address, waitMs])

  return verdict
}
