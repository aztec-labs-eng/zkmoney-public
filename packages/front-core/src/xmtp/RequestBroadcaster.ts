/**
 * Orchestrator for the payment-request lifecycle over XMTP: announce a request
 * to a contact, and signal a decline back to the requester. (Fulfillment rides the
 * on-chain `Transfer.meta`, not XMTP.)
 *
 * Two entry points — `announce`, `signalDeclined`. Each
 * follows one pipeline: resolve `canMessage`, build the
 * codec content, ship it through the injected `IXmtpSender`, and return a
 * discriminated `BroadcastStatus`. **Never throws** — every failure surface is
 * a status so callers pick their own UI policy. No retry, no persistence.
 *
 * Depends only on `@obsidion/sdk`'s pure builders + the injected `IXmtpSender`
 * adapter — no XMTP SDK, no PXE imports. The platform supplies the real
 * adapter; tests use a hand-rolled fake.
 */

import { buildPaymentRequest, buildPaymentRequestDeclined } from "@obsidion/sdk"

import type { BroadcastStatus, IXmtpSender } from "./types.js"

/** Inputs to `announce` — mirrors the shape needed to build a `request`. */
export interface AnnounceRequestInput {
  /** Requester's resolved XMTP address (from the ens-gateway tag lookup). */
  recipientXmtpAddress: string | null | undefined
  /** Join key minted by the requester (`0x`-hex field); echoed back on decline, rides `Transfer.meta` on fulfillment. */
  requestId: string
  /** Requester's normalized Aztec tag — the payee. */
  requesterTag: string
  /** Amount in the token's smallest units. `0` = "any amount". */
  amountAtomic: string | bigint
  /** The token's on-chain address (hex) and UI metadata. */
  token: {
    address: string
    symbol?: string
    decimals: number
  }
  /** Aztec network the request targets. */
  networkId: string
  /** Optional short note, ≤500 chars per the content-type schema. */
  note?: string
  /** Optional soft expiry (epoch ms). */
  expiresAt?: number
}

/** Inputs to `signalDeclined` — sent by the payer back to the requester. */
export interface SignalDeclinedInput {
  recipientXmtpAddress: string | null | undefined
  requestId: string
  networkId: string
}

export class RequestBroadcaster {
  constructor(private readonly xmtp: IXmtpSender) {}

  async announce(input: AnnounceRequestInput): Promise<BroadcastStatus> {
    return this.send(input.recipientXmtpAddress, () =>
      buildPaymentRequest({
        requestId: input.requestId,
        requesterTag: input.requesterTag,
        amountAtomic: input.amountAtomic,
        token: input.token,
        networkId: input.networkId,
        note: input.note,
        expiresAt: input.expiresAt,
      }),
    )
  }

  async signalDeclined(input: SignalDeclinedInput): Promise<BroadcastStatus> {
    return this.send(input.recipientXmtpAddress, () =>
      buildPaymentRequestDeclined({
        requestId: input.requestId,
        networkId: input.networkId,
      }),
    )
  }

  /**
   * Shared pipeline: reachability check → build (may throw on malformed input)
   * → send. The `build` thunk is deferred so a builder throw surfaces as
   * `failed`, not an escaping exception.
   */
  private async send(
    recipientXmtpAddress: string | null | undefined,
    build: () => Parameters<IXmtpSender["sendRequest"]>[1],
  ): Promise<BroadcastStatus> {
    const recipient = (recipientXmtpAddress ?? "").trim()
    if (recipient.length === 0) {
      return { status: "skipped", reason: "no-xmtp-address" }
    }

    let reachability: Record<string, boolean>
    try {
      reachability = await this.xmtp.canMessage([recipient])
    } catch (cause) {
      return failedFrom(cause)
    }

    if (!isReachable(reachability, recipient)) {
      return { status: "skipped", reason: "recipient-not-reachable" }
    }

    let content
    try {
      content = build()
    } catch (cause) {
      return failedFrom(cause)
    }

    try {
      const messageId = await this.xmtp.sendRequest(recipient, content)
      return { status: "sent", messageId }
    } catch (cause) {
      return failedFrom(cause)
    }
  }
}

function isReachable(map: Record<string, boolean>, address: string): boolean {
  return map[address.toLowerCase()] === true || map[address] === true
}

function failedFrom(cause: unknown): BroadcastStatus {
  const reason = cause instanceof Error ? cause.message : String(cause)
  return { status: "failed", reason, cause }
}
