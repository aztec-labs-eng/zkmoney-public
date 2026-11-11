/**
 * Accountless request payment: build the EIP-681 URI a visitor pays from any L1 wallet. An
 * embedded `sipaAddress` is the payee directly; otherwise the requester's tag CCIP-resolves to
 * one (slow — the resolver proves per resolution). Pure async with injected deps; the screen
 * owns single-flight and retry. No wallet, no PXE.
 *
 * An embedded SIPA rides in an unsigned fragment, so a tag pin that cannot be checked is reported
 * as `tagWarning` rather than thrown — the payee is the address, and the screen must say so. A tag
 * that now names another L2 account than the link pins refuses: the address pays the old account,
 * and a payment sent on to the new one would not match the request. An address takes one payment,
 * so an embedded one that has already been paid or swept gives way to a resolved one.
 *
 * Fee model: a SIPA deposit costs the quoted deposit fee, so fulfilling a request
 * of X means sending X + fee. Amounts at or below it leave nothing to credit — the
 * screen must surface the floor for any-amount links.
 */
import { erc20Abi, type Address, type Hex, type PublicClient } from "viem"
import { bestEffort, WalletError } from "@obsidion/core/errors"
import type { OxideEnvTuple } from "@obsidion/core/types"
import {
  deploymentScanRange,
  deploymentSipaRoute,
  type RegistryTagResolution,
  sipaDeploymentTag,
  type RequestInlinePacket,
  type SipaLinkPreimage,
} from "@obsidion/front-core"
import {
  readDepositFee,
  readDepositSIPAImplementation,
  readUserL2AddressHistory,
  resolveSipaAddress,
  SELF_BROADCAST_RESWEEPABLE,
  SipaNameUndepositableError,
} from "@obsidion/sdk"
import { requireTupleField } from "../../config/oxideTuple"
import { withTimeout } from "../../lib/withTimeout"
import { predictSipaCandidate } from "../deposit/sipaPredict"
import {
  RequestDecimalsMismatchError,
  RequesterNotUpgradedError,
  requesterMismatch,
} from "./accountlessRequestErrors"
import type { RequesterMismatch } from "./accountlessRequestErrors"
import { buildErc20TransferUri, buildErc20TransferUriWithoutAmount } from "./eip681"

export interface AccountlessResolveResult {
  sipaAddress: string
  /** The manifest token the URI asks for, and its decimals as the token contract reports them. */
  token: Address
  decimals: number
  feeAtomic: bigint
  /** amountAtomic + fee for a fixed-amount request; 0n for an any-amount link. */
  grossAtomic: bigint
  paymentUri: string
  tagWarning?: TagWarning
  deployment: LinkDeployment
}

/**
 * Why the tag pin could not be checked, so the link's address is still the payee: the tag lookup
 * failed, the tag is gone, or it is on a retired rollup.
 */
export type TagWarning = "unchecked" | "unregistered" | "notUpgraded"

/**
 * `active`: the address is the active deployment's, re-predicted from the link's preimage, matched by
 * a code's deployment tag, or resolved just now. `expired`: the link's deployment is gone.
 * `unproven`: a link minted without a preimage.
 */
export type LinkDeployment = "active" | "expired" | "unproven"

export async function linkDeployment(
  packet: Pick<RequestInlinePacket, "sipaAddress" | "sipaPreimage" | "sipaDeployment">,
  predict: (preimage: SipaLinkPreimage) => Promise<Address>,
  activeTag: string,
): Promise<LinkDeployment> {
  if (packet.sipaAddress && packet.sipaDeployment)
    return packet.sipaDeployment === activeTag ? "active" : "expired"
  if (!packet.sipaAddress || !packet.sipaPreimage) return "unproven"
  const predicted = await predict(packet.sipaPreimage)
  return predicted.toLowerCase() === packet.sipaAddress.toLowerCase() ? "active" : "expired"
}

/** The self-broadcast deposit SIPA `preimage` names under the active deployment. */
function predictActiveSipa(
  publicClient: PublicClient,
  tuple: OxideEnvTuple,
  implementation: Address,
  preimage: SipaLinkPreimage,
): Promise<Address> {
  const sipaFactory = requireTupleField(tuple, "sipaFactory") as Address
  const common = {
    implementation,
    intentHash: preimage.intentHash as Hex,
    rollupVersion: BigInt(requireTupleField(tuple, "rollupVersion")),
    resweepable: SELF_BROADCAST_RESWEEPABLE,
  }
  // A 20-byte recovery is a legacy-eoa address; 32 bytes an account commitment.
  return predictSipaCandidate(
    publicClient,
    preimage.recovery.length === 42
      ? {
          protocol: "legacy-eoa",
          sipaFactory,
          args: { ...common, recoveryAddress: preimage.recovery as Address },
        }
      : {
          protocol: "account",
          sipaFactory,
          args: {
            ...common,
            recoveryCommitment: preimage.recovery as Hex,
            forwardingTable: requireTupleField(tuple, "forwardingTable") as Address,
          },
        },
  )
}

export async function resolveAccountlessRequest(
  packet: RequestInlinePacket,
  deps: {
    tuple: OxideEnvTuple
    publicClient: PublicClient
    resolveRequester(tag: string): Promise<RegistryTagResolution>
    chainId: number
    /** Every token a SIPA of the table accepts, so a payment in any of them marks its address used. */
    acceptedTokens: readonly Address[]
    timeoutMs?: number
  },
): Promise<AccountlessResolveResult> {
  const token = requireTupleField(deps.tuple, "token") as Address
  // The payee is a deposit SIPA either way — embedded or CCIP-resolved — so the amount this URI
  // asks for is priced off what its sweep costs: the deployment's deposit row fee.
  const [implementation, feeAtomic, decimals] = await Promise.all([
    readDepositSIPAImplementation(
      deps.publicClient,
      requireTupleField(deps.tuple, "sipaFactory") as Address,
    ),
    readDepositFee(deps.publicClient, deploymentSipaRoute(deps.tuple)),
    deps.publicClient.readContract({ address: token, abi: erc20Abi, functionName: "decimals" }),
  ])
  const fixed = packet.amountAtomic > 0n
  // The URI asks for the link's amount in this token's base units, so a link that scales it
  // differently would ask for a different amount than it shows. A link without decimals is read
  // as 6, as the codec defines. An any-amount URI carries no amount to scale.
  const declared = packet.tokenDecimals ?? 6
  if (fixed && declared !== decimals) throw new RequestDecimalsMismatchError(declared, decimals)

  const tagWarning = await pinRequester(packet, deps)
  let sipaAddress = packet.sipaAddress as Address | undefined
  // A failed check leaves the address as unproven as a link without a preimage.
  const activeTag = sipaDeploymentTag({
    sipaFactory: requireTupleField(deps.tuple, "sipaFactory"),
    implementation,
    rollupVersion: requireTupleField(deps.tuple, "rollupVersion"),
  })
  let deployment = await linkDeployment(
    packet,
    (preimage) => predictActiveSipa(deps.publicClient, deps.tuple, implementation, preimage),
    activeTag,
  ).catch((err): LinkDeployment => {
    console.warn("[request] could not check the link's deployment", err)
    return "unproven"
  })
  // An expired link is shown as expired, never replaced.
  if (
    sipaAddress &&
    deployment !== "expired" &&
    !(await isUnpaid(
      deps.publicClient,
      [token, ...deps.acceptedTokens.filter((t) => t.toLowerCase() !== token.toLowerCase())],
      sipaAddress,
    ))
  )
    sipaAddress = undefined
  if (!sipaAddress) {
    // A CCIP address is derived from the live tag, so an unresolvable tag has no payee at all.
    if (tagWarning === "notUpgraded") throw new RequesterNotUpgradedError(packet.requesterTag)
    if (tagWarning === "unregistered")
      throw new WalletError("contact.unregistered", undefined, {
        data: { tag: packet.requesterTag },
      })
    if (tagWarning === "unchecked") throw new WalletError("contact.unavailable")
    sipaAddress = await resolveSipaViaCcip(packet, deps)
    deployment = "active"
  }

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
    token,
    decimals,
    feeAtomic,
    grossAtomic,
    paymentUri,
    deployment,
    ...(tagWarning ? { tagWarning } : {}),
  }
}

/** No balance in any accepted token and no code: a sweep deploys the SIPA, so a swept address has code. */
async function isUnpaid(
  publicClient: PublicClient,
  tokens: Address[],
  sipa: Address,
): Promise<boolean> {
  const [code, ...balances] = await Promise.all([
    publicClient.getCode({ address: sipa }),
    ...tokens.map((address) =>
      publicClient.readContract({
        address,
        abi: erc20Abi,
        functionName: "balanceOf",
        args: [sipa],
      }),
    ),
  ])
  return !code && balances.every((b) => b === 0n)
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
  } catch (e) {
    if (e instanceof SipaNameUndepositableError)
      throw new RequesterNotUpgradedError(packet.requesterTag)
    throw e
  } finally {
    clearTimeout(timer)
  }
}

/** Throws `contact.requestMismatch` when the tag names another L2 account than the link or code pins. */
async function pinRequester(
  packet: RequestInlinePacket,
  deps: {
    tuple: OxideEnvTuple
    publicClient: PublicClient
    resolveRequester(tag: string): Promise<RegistryTagResolution>
  },
): Promise<TagWarning | undefined> {
  const resolution = await bestEffort(
    "contact.unavailable",
    deps.resolveRequester(packet.requesterTag),
  )
  if (!resolution) return "unchecked"
  if (resolution.status === "staleRollup") return "notUpgraded"
  if (resolution.status !== "resolved") return "unregistered"
  const pin = packet.requesterAddress ?? packet.requesterPin
  if (pin && !pins(pin, resolution.l2Address)) {
    throw requesterMismatch(
      packet.requesterTag,
      await mismatchReason(deps, resolution.account as Address, pin),
    )
  }
  return undefined
}

/** A full link pins the whole L2 address; a code pins its first bytes. */
function pins(pin: string, l2Address: string): boolean {
  return l2Address.toLowerCase().startsWith(pin.toLowerCase())
}

/** How long a refusal waits to say why, so the payer soon reads not to pay. */
export const MISMATCH_REASON_TIMEOUT_MS = 8_000

/**
 * Whether `account`'s record named the pinned address at any point in the active deployment's life.
 * A failed or slow read still refuses: the mismatch is known, only its cause is not.
 */
async function mismatchReason(
  deps: { tuple: OxideEnvTuple; publicClient: PublicClient },
  account: Address,
  pin: string,
): Promise<RequesterMismatch> {
  const read = async () =>
    readUserL2AddressHistory(
      deps.publicClient,
      requireTupleField(deps.tuple, "accountMetadataRegistry") as Address,
      account,
      await deploymentScanRange(deps.publicClient, deps.tuple),
    )
  const history = await bestEffort(
    "contact.requestMismatch",
    withTimeout(read(), MISMATCH_REASON_TIMEOUT_MS),
  )
  if (!history) return "unknown"
  return history.some((recorded) => pins(pin, recorded)) ? "moved" : "otherOwner"
}
