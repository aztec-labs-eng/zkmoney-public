/**
 * Accountless request payment: build the EIP-681 URI a visitor pays from any L1 wallet. An
 * embedded `sipaAddress` is the payee directly; otherwise the requester's tag CCIP-resolves to
 * one (slow — the resolver proves per resolution). Pure async with injected deps; the screen
 * owns single-flight and retry. No wallet, no PXE.
 *
 * An embedded SIPA rides in an unsigned fragment, so a failed tag pin is reported as
 * `tagWarning` rather than thrown — the payee is the address, and the screen must say so.
 *
 * Fee model: a SIPA deposit costs the quoted deposit fee, so fulfilling a request
 * of X means sending X + fee. Amounts at or below it leave nothing to credit — the
 * screen must surface the floor for any-amount links.
 */
import type { Address, PublicClient } from "viem"
import type { OxideEnvTuple } from "@obsidion/core/types"
import {
  depositSipaImplementation,
  type RegistryTagResolution,
  type RequestInlinePacket,
} from "@obsidion/front-core"
import { quotedDepositFee } from "@obsidion/core/constants"
import { readDepositFee, resolveSipaAddress } from "@obsidion/sdk"
import { requireTupleField } from "../../config/oxideTuple"
import { fpcFundingCut } from "../fees/fpcFundingCut"
import { buildErc20TransferUri, buildErc20TransferUriWithoutAmount } from "./eip681"

export interface AccountlessResolveResult {
  sipaAddress: string
  feeAtomic: bigint
  /** amountAtomic + fee for a fixed-amount request; 0n for an any-amount link. */
  grossAtomic: bigint
  paymentUri: string
  /** Tag pin failed or the @tag no longer matches — the SIPA is still the payee. */
  tagWarning?: string
}

export async function resolveAccountlessRequest(
  packet: RequestInlinePacket,
  deps: {
    tuple: OxideEnvTuple
    publicClient: PublicClient
    resolveRequester(tag: string): Promise<RegistryTagResolution>
    chainId: number
    timeoutMs?: number
  },
): Promise<AccountlessResolveResult> {
  const token = requireTupleField(deps.tuple, "token") as Address
  // The payee is a deposit SIPA either way — embedded or CCIP-resolved — so the amount this URI
  // asks for is priced off what its sweep costs: this portal's sweep fee and its cut.
  const implementation = await depositSipaImplementation(
    deps.publicClient,
    requireTupleField(deps.tuple, "sipaFactory") as Address,
    requireTupleField(deps.tuple, "portal") as Address,
  )
  const [relayerFee, cut] = await Promise.all([
    readDepositFee(deps.publicClient, implementation),
    fpcFundingCut(deps.publicClient, requireTupleField(deps.tuple, "portal") as Address),
  ])
  const feeAtomic = quotedDepositFee(relayerFee, cut)

  const pin = await pinRequester(packet, deps)
  let sipaAddress = packet.sipaAddress as Address | undefined
  if (!sipaAddress) {
    // A CCIP address is derived from the live tag, so an unresolvable tag has no payee at all.
    if (pin.error) throw new Error(pin.error)
    sipaAddress = await resolveSipaViaCcip(packet, deps)
  }

  const fixed = packet.amountAtomic > 0n
  const grossAtomic = fixed ? packet.amountAtomic + feeAtomic : 0n
  const paymentUri = fixed
    ? buildErc20TransferUri({
        token,
        chainId: deps.chainId,
        to: sipaAddress,
        rawAmount: grossAtomic,
      })
    : buildErc20TransferUriWithoutAmount({ token, chainId: deps.chainId, to: sipaAddress })

  return {
    sipaAddress,
    feeAtomic,
    grossAtomic,
    paymentUri,
    ...(pin.error ? { tagWarning: pin.error } : {}),
  }
}

async function resolveSipaViaCcip(
  packet: RequestInlinePacket,
  deps: {
    tuple: OxideEnvTuple
    publicClient: PublicClient
    timeoutMs?: number
  },
): Promise<Address> {
  const sipaResolver = requireTupleField(deps.tuple, "sipaResolver") as Address
  const ensDomain = requireTupleField(deps.tuple, "ensDomain")
  const timeoutMs = deps.timeoutMs ?? 60_000
  let timer: ReturnType<typeof setTimeout> | undefined
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error("Address resolution timed out — try again")),
      timeoutMs,
    )
  })
  try {
    return await Promise.race([
      resolveSipaAddress(deps.publicClient, sipaResolver, `${packet.requesterTag}.${ensDomain}`),
      deadline,
    ])
  } finally {
    clearTimeout(timer)
  }
}

async function pinRequester(
  packet: RequestInlinePacket,
  deps: { resolveRequester(tag: string): Promise<RegistryTagResolution> },
): Promise<{ error?: string }> {
  try {
    const resolution = await deps.resolveRequester(packet.requesterTag)
    if (resolution.status !== "resolved") {
      return { error: `@${packet.requesterTag} is no longer registered` }
    }
    if (
      packet.requesterAddress &&
      resolution.l2Address.toLowerCase() !== packet.requesterAddress.toLowerCase()
    ) {
      return { error: `@${packet.requesterTag} no longer matches this payment request` }
    }
    return {}
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) }
  }
}
