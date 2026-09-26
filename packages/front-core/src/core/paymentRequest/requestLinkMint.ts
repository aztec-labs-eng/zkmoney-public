/**
 * Pure request-link minting. Platform callers own
 * request-id generation, wallet/network lookups, persistence, sharing UI, and
 * amount/expiry display formatting from the returned row.
 */
import { Network } from "@obsidion/core/constants"
import { parseEscrowAmount } from "../../utils/escrowAmount"
import type { PaymentRequest } from "../storages/RequestStorage"
import { encodeRequestInline } from "./requestInlineCodec"

const MS_PER_DAY = 24 * 60 * 60 * 1000
const MS_PER_HOUR = 60 * 60 * 1000
const MS_PER_MIN = 60 * 1000

/** Landing-page origin for shareable `/claim` and `/request` links (DESIGN §2.3). */
export function paylinkLandingBaseUrl(network: Network): string {
  return network === Network.MAINNET ? "https://paylink.zk.money" : "https://paylink.test.zk.money"
}

function requestLinkUrl(baseUrl: string, fragment: string): string {
  return `${baseUrl.replace(/\/$/, "")}/request#${fragment}`
}

/** "3 days" / "5 hours" / "5 mins" — coarsest unit that fits, singular below 2. */
export function formatExpiryDuration(ms: number): string {
  if (ms >= MS_PER_DAY) {
    const days = Math.round(ms / MS_PER_DAY)
    return `${days} ${days === 1 ? "day" : "days"}`
  }
  if (ms >= MS_PER_HOUR) {
    const hours = Math.round(ms / MS_PER_HOUR)
    return `${hours} ${hours === 1 ? "hour" : "hours"}`
  }
  const mins = Math.max(1, Math.round(ms / MS_PER_MIN))
  return `${mins} ${mins === 1 ? "min" : "mins"}`
}

export interface MintRequestLinkArgs {
  /** 0x-hex 254-bit field minted by the platform caller. */
  requestId: string
  /** Raw registered tag (bare, no @). */
  requesterTag: string
  requesterAddress?: string
  tokenAddress: string
  tokenDecimals: number
  tokenSymbol: string
  networkId: string
  /** Landing origin — `paylinkLandingBaseUrl(network)` (no trailing slash). */
  baseUrl: string
  /** Blank or non-positive input mints an any-amount link. */
  amountInput: string
  noteInput: string
  durationMs: number
  now: number
  /** Self-broadcast L1 SIPA. Optional on the v3 fragment. */
  sipaAddress?: string
}

export interface MintedRequestLink {
  url: string
  row: PaymentRequest
  note?: string
}

export class RequestLinkMintError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "RequestLinkMintError"
  }
}

/**
 * Rebuild a shareable URL from a persisted outgoing link request. The mint-time tag wins so a
 * later rename cannot change the original request identity; `currentRequesterTag` supports older
 * rows that predate the persisted requester identity. A stored SIPA is written back onto the v3 fragment.
 */
export function buildRequestShareUrl(
  request: PaymentRequest,
  currentRequesterTag: string,
  baseUrl: string,
): string | null {
  if (!request.networkId || !request.tokenAddress) return null
  try {
    const fragment = encodeRequestInline({
      requestId: request.id,
      requesterTag: request.requesterTag || currentRequesterTag,
      ...(request.requesterAddress !== undefined && {
        requesterAddress: request.requesterAddress,
      }),
      amountAtomic: BigInt(request.amountAtomic ?? "0"),
      tokenAddress: request.tokenAddress,
      tokenSymbol: request.asset,
      // Preserve absence for legacy 6-dp rows so the decoder's 6-dp fallback remains authoritative.
      ...(request.tokenDecimals !== undefined && { tokenDecimals: request.tokenDecimals }),
      ...(request.note !== undefined && { note: request.note }),
      ...(request.expiresAt !== undefined && { expiresAt: request.expiresAt }),
      networkId: request.networkId,
      ...(request.sipaAddress !== undefined && { sipaAddress: request.sipaAddress }),
    })
    return requestLinkUrl(baseUrl, fragment)
  } catch {
    return null
  }
}

/** Throws RequestLinkMintError for an unparseable non-empty amount. */
export function mintRequestLink(args: MintRequestLinkArgs): MintedRequestLink {
  let human = 0
  let amountAtomic = "0"
  if (args.amountInput.trim()) {
    try {
      const escrow = parseEscrowAmount(args.amountInput, args.tokenDecimals)
      if (escrow.human > 0) {
        human = escrow.human
        amountAtomic = escrow.atomic.toString()
      }
    } catch {
      throw new RequestLinkMintError(`invalid amount: ${args.amountInput}`)
    }
  }

  const note = args.noteInput.trim() || undefined
  const expiresAt = args.now + args.durationMs
  const fragment = encodeRequestInline({
    requestId: args.requestId,
    requesterTag: args.requesterTag,
    requesterAddress: args.requesterAddress,
    amountAtomic: BigInt(amountAtomic),
    tokenAddress: args.tokenAddress,
    tokenDecimals: args.tokenDecimals,
    tokenSymbol: args.tokenSymbol,
    note,
    expiresAt,
    networkId: args.networkId,
    sipaAddress: args.sipaAddress,
  })

  const row: PaymentRequest = {
    id: args.requestId,
    contactTag: "",
    amount: human,
    asset: args.tokenSymbol,
    direction: "outgoing",
    status: "pending",
    createdAt: args.now,
    kind: "link",
    amountAtomic,
    tokenAddress: args.tokenAddress,
    tokenDecimals: args.tokenDecimals,
    note,
    expiresAt,
    networkId: args.networkId,
    requesterTag: args.requesterTag,
    requesterAddress: args.requesterAddress,
    sipaAddress: args.sipaAddress,
  }

  return {
    url: requestLinkUrl(args.baseUrl, fragment),
    row,
    note,
  }
}
