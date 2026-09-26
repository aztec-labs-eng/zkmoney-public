/**
 * `/request#<fragment>` — the payer's entry to a payment-request link.
 *
 * With a local identity the packet validates (legacy links tolerated) and the flow hands off to the
 * existing contact send screen with the request in router state. Without one it renders the
 * invitation landing: the requested amount over a choice of how to pay — signing up, or an external
 * L1 wallet paying the requester's SIPA deposit address.
 *
 * The SIPA resolve runs on mount, outside AccountGate, so it overlaps the PXE boot the signup route
 * needs. An embedded `sipaAddress` is the payee directly; without one the tag CCIP-resolves to one.
 * No XMTP signal is sent (no account) — the requester's wallet joins the claimed deposit to the
 * minted row by address instead.
 */
import { useEffect, useMemo, useRef, useState } from "react"
import { Outlet, useLocation, useNavigate } from "react-router-dom"
import { createPublicClient, formatUnits, type PublicClient } from "viem"
import { decodeRequestInline, normalizeTag, type RequestInlinePacket } from "@obsidion/front-core"
import { Card, Icon, PrimaryGradientButton, ScreenNavBar, Spinner } from "@obsidion/web-ds"
import { getConfig, l1Transport } from "../../config/env"
import type { AztecNode } from "@aztec/aztec.js/node"
import { getOxideTuple } from "../../config/oxideTuple"
import { fireEvent, requestAmountBucket } from "../../lib/analytics"
import { usdBalance, usdFigure } from "../../ui/format"
import { loadOnboardedIdentity } from "../identity/walletIdentity"
import { resolveTagForCommit } from "../contacts/registryResolution"
import { InvitationChrome } from "../onboarding/InvitationChrome"
import { resolveAccountlessRequest, type AccountlessResolveResult } from "./accountlessRequest"
import { ExternalWalletPayModal } from "./ExternalWalletPayModal"
import { requestAmountDisplay, validateRequestPacket, type RequestLinkProblem } from "./requestLink"

const PROBLEM_COPY: Record<RequestLinkProblem, string> = {
  expired: "This payment request has expired.",
  wrongNetwork: "This payment request is for a different network.",
  wrongToken: "This payment request is for a token this wallet doesn't support.",
  legacyUnverifiable:
    "This link is from an older app version and can't be paid from the web without an account — sign up, or open it in the zk.money app.",
}

async function fetchRollupAddress(node: AztecNode): Promise<string> {
  const { rollupAddress } = await node.getL1ContractAddresses()
  return rollupAddress.toString()
}

export function RequestLandingScreen({ node }: { node: AztecNode }) {
  const location = useLocation()
  const fragment = location.hash.replace(/^#/, "")
  // A signed-in payer who chose the Ethereum route on the send sheet comes back here for it.
  const forceExternal = (location.state as { external?: boolean } | null)?.external === true
  const packet = useMemo(() => {
    try {
      const decoded = decodeRequestInline(fragment)
      // The link is untrusted input and its tag derives the payee's deposit address, which a
      // different case resolves differently. Fold it once here so every consumer agrees; a tag
      // that does not survive the fold is a link nothing can be paid to.
      const requesterTag = normalizeTag(decoded.requesterTag)
      return requesterTag === null ? null : { ...decoded, requesterTag }
    } catch {
      return null
    }
  }, [fragment])
  // Synchronous branch: localStorage identity + MSK breadcrumb, no gate needed.
  const hasIdentity = !!loadOnboardedIdentity()

  if (!packet) {
    return (
      <div className="ww-flow">
        <ScreenNavBar title="Payment request" />
        <Card style={{ marginTop: 24 }}>
          <div style={{ textAlign: "center", padding: "18px 8px", color: "var(--text-secondary)" }}>
            This payment-request link could not be read.
          </div>
        </Card>
      </div>
    )
  }
  return hasIdentity && !forceExternal ? (
    <SignedInRequest packet={packet} node={node} />
  ) : (
    <AccountlessRequest key={fragment} packet={packet} node={node} signedIn={hasIdentity} />
  )
}

/** Validate, then hand off to the existing contact send flow with the request in router state. */
function SignedInRequest({ packet, node }: { packet: RequestInlinePacket; node: AztecNode }) {
  const navigate = useNavigate()
  const { hash } = useLocation()
  const [problem, setProblem] = useState<RequestLinkProblem | null>(null)
  const [error, setError] = useState<string>()

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        const [rollupAddress, tuple] = await Promise.all([
          fetchRollupAddress(node),
          getOxideTuple(getConfig()),
        ])
        if (cancelled) return
        const found = validateRequestPacket(packet, {
          rollupAddress,
          l2Token: tuple.l2Token,
          requireTokenAddress: false,
        })
        if (found) {
          setProblem(found)
          return
        }
        const amountDisplay = requestAmountDisplay(packet)
        navigate(`/contacts/${encodeURIComponent(packet.requesterTag)}/send`, {
          replace: true,
          state: {
            request: {
              id: packet.requestId,
              tag: packet.requesterTag,
              amount: amountDisplay ? Number(amountDisplay) : 0,
              source: "link",
              requesterAddress: packet.requesterAddress,
              note: packet.note,
              hash,
            },
          },
        })
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e))
      }
    })()
    return () => {
      cancelled = true
    }
  }, [packet, navigate])

  return (
    <div className="ww-flow">
      <ScreenNavBar title="Payment request" />
      {problem || error ? (
        <Card style={{ marginTop: 24 }}>
          <div style={{ textAlign: "center", padding: "18px 8px", color: "var(--text-secondary)" }}>
            {problem ? PROBLEM_COPY[problem] : error}
          </div>
        </Card>
      ) : (
        <div style={{ display: "flex", justifyContent: "center", padding: "48px 0" }}>
          <Spinner />
        </div>
      )}
    </div>
  )
}

type PanelState =
  | { kind: "loading" }
  | { kind: "problem"; problem: RequestLinkProblem }
  | { kind: "resolved"; result: AccountlessResolveResult }
  | { kind: "error"; message: string; retryable: boolean }

/** No-account surface: the requested amount over the two ways to pay it. */
/** `signedIn`: the payer has an account and picked the Ethereum route on the send sheet, so the
 *  signup option and the log-in foot make no sense; the foot offers the send sheet instead. */
function AccountlessRequest({
  packet,
  node,
  signedIn = false,
}: {
  packet: RequestInlinePacket
  node: AztecNode
  signedIn?: boolean
}) {
  const navigate = useNavigate()
  const { hash } = useLocation()
  const [signup, setSignup] = useState(false)
  // "Pay with zk.money" asks first whether an account exists: Log in leads, Create account follows.
  const [receiving, setReceiving] = useState(false)
  const [payOpen, setPayOpen] = useState(false)
  const [state, setState] = useState<PanelState>({ kind: "loading" })
  const [attempt, setAttempt] = useState(0)
  // Keep one resolution per packet/attempt, including development effect replay.
  const inFlight = useRef<{
    packet: RequestInlinePacket
    attempt: number
    result: Promise<PanelState>
  } | null>(null)

  const decimals = packet.tokenDecimals ?? 6
  const amountDisplay = requestAmountDisplay(packet)

  // The signed-in path reports its open from the contact send screen; this covers the
  // accountless surface (usually a no-op — a visitor with no account granted no consent).
  useEffect(() => {
    fireEvent("request_opened", {
      source: "link",
      amount_bucket: requestAmountBucket(amountDisplay ? Number(amountDisplay) : 0),
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps -- mount-only funnel entry
  }, [])

  useEffect(() => {
    if (inFlight.current?.packet !== packet || inFlight.current.attempt !== attempt) {
      const result = (async (): Promise<PanelState> => {
        try {
          const config = getConfig()
          const [rollupAddress, tuple] = await Promise.all([
            fetchRollupAddress(node),
            getOxideTuple(config),
          ])
          const problem = validateRequestPacket(packet, {
            rollupAddress,
            l2Token: tuple.l2Token,
            requireTokenAddress: true,
          })
          if (problem) return { kind: "problem", problem }
          const publicClient = createPublicClient({
            chain: config.l1Chain,
            transport: l1Transport(config),
          }) as PublicClient
          const resolved = await resolveAccountlessRequest(packet, {
            tuple,
            publicClient,
            resolveRequester: resolveTagForCommit,
            chainId: config.l1ChainId,
          })
          return { kind: "resolved", result: resolved }
        } catch (e) {
          const message = e instanceof Error ? e.message : String(e)
          // Registry identity failures are final; network/resolve failures retry.
          return { kind: "error", message, retryable: !message.includes("no longer") }
        }
      })()
      inFlight.current = { packet, attempt, result }
    }
    // Each effect run observes the shared operation through its own cancellable subscription.
    let cancelled = false
    setState({ kind: "loading" })
    void inFlight.current.result.then((next) => {
      if (!cancelled) setState(next)
    })
    return () => {
      cancelled = true
    }
  }, [packet, attempt])

  const result = state.kind === "resolved" ? state.result : undefined
  // Signup returns here, where the identity branch hands the request to the send flow.
  const startSignup = () => {
    setSignup(true)
    navigate({ pathname: "/request", hash }, { replace: true, state: { next: `/request${hash}` } })
  }

  if (signup) {
    return (
      <InvitationChrome>
        <Outlet />
      </InvitationChrome>
    )
  }

  if (receiving) {
    return (
      <InvitationChrome>
        <div className="ww-invite__content ww-invite__content--landing">
          <span className="ww-invite-modal-badge">
            <Icon name="link" size={32} color="#fff" />
          </span>
          <div className="ww-paylink-summary">
            <span className="ww-paylink-summary__label">Someone requested</span>
            <span className="ww-paylink-summary__amount">
              {amountDisplay ? usdBalance(amountDisplay) : "Any amount"}
            </span>
          </div>
          <p className="ww-paylink-summary__caption">Pay with zk.money</p>
          <div className="ww-claim-modal__actions">
            <PrimaryGradientButton
              title="Log in"
              onClick={() => navigate("/enter", { state: { next: `/request${hash}` } })}
            />
            <PrimaryGradientButton title="Create account" buttonStyle="dark" onClick={startSignup} />
          </div>
          <p className="ww-invite-modal-foot">
            <button
              type="button"
              className="zkm-btn-reset ww-invite__link"
              onClick={() => setReceiving(false)}
            >
              Back to payment options
            </button>
          </p>
        </div>
      </InvitationChrome>
    )
  }

  const externalCaption = () => {
    if (state.kind === "error") return "Couldn't prepare a payment address."
    if (!result) return "Preparing a payment address…"
    return packet.amountAtomic > 0n
      ? `Pay ${usdFigure(
          formatUnits(result.grossAtomic, decimals),
        )} with fee. Public onchain payment.`
      : "Public onchain payment."
  }

  return (
    <InvitationChrome>
      <div className="ww-invite__content ww-invite__content--landing">
        <span className="ww-invite-modal-badge">
          <Icon name="link" size={32} color="#fff" />
        </span>
        <div className="ww-paylink-summary">
          <span className="ww-paylink-summary__label">Someone requested</span>
          <span className="ww-paylink-summary__amount">
            {amountDisplay ? usdBalance(amountDisplay) : "Any amount"}
          </span>
          {packet.note && <span className="ww-paylink-summary__note">{packet.note}</span>}
        </div>

        {state.kind === "problem" ? (
          <p className="ww-paylink-summary__caption">{PROBLEM_COPY[state.problem]}</p>
        ) : (
          <>
            {/* The @tag is the identity on screen but the link supplies the address — a mismatch
                has to outrank the pay buttons, not sit under them. */}
            {result?.tagWarning && (
              <p className="ww-invite-modal-error" role="alert">
                {result.tagWarning} — check with them before sending.
              </p>
            )}
            <p className="ww-paylink-summary__caption">
              {signedIn ? "Pay with an Ethereum wallet" : "Choose a method to pay"}
            </p>
            <div className="ww-paymethods">
              {!signedIn && (
                <button
                  type="button"
                  className="zkm-btn-reset zkm-pressable ww-deposit__connect ww-paymethod ww-paymethod--best"
                  onClick={() => setReceiving(true)}
                >
                  <span className="ww-paymethod__flag">
                    <span>Free</span>
                  </span>
                  <span className="ww-deposit__connect-icon">
                    <Icon name="lock-shield" size={24} color="#fff" />
                  </span>
                  <span className="ww-deposit__connect-text">
                    <b>Pay with zk.money</b>
                    <span>No fee and your balance stays private.</span>
                  </span>
                  <Icon name="chevron-right" size={16} color="var(--text-secondary)" />
                </button>
              )}

              <button
                type="button"
                className="zkm-btn-reset zkm-pressable ww-deposit__connect ww-paymethod"
                disabled={!result}
                onClick={() => setPayOpen(true)}
              >
                <span className="ww-deposit__connect-icon">
                  <Icon name="wallet" size={24} color="#fff" />
                </span>
                <span className="ww-deposit__connect-text">
                  <b>Pay with an Ethereum wallet</b>
                  <span>{externalCaption()}</span>
                </span>
                {state.kind === "loading" ? (
                  <Spinner size={16} />
                ) : result ? (
                  <Icon name="chevron-right" size={16} color="var(--text-secondary)" />
                ) : null}
              </button>
            </div>

            {state.kind === "error" && (
              <>
                <p className="ww-invite-modal-error" role="alert">
                  {state.message}
                </p>
                {state.retryable && (
                  <PrimaryGradientButton
                    title="Try again"
                    onClick={() => setAttempt((n) => n + 1)}
                  />
                )}
              </>
            )}
          </>
        )}

        {signedIn ? (
          <p className="ww-invite-modal-foot">
            {/* Dropping the route flag re-enters the identity branch, which hands the request back
                to the send sheet with its state rebuilt from the packet. */}
            <button
              type="button"
              className="zkm-btn-reset ww-invite__link"
              onClick={() => navigate({ pathname: "/request", hash }, { replace: true })}
            >
              Pay with zk.money instead
            </button>
          </p>
        ) : (
          <p className="ww-invite-modal-foot">
            Already have an account?{" "}
            <button
              type="button"
              className="zkm-btn-reset ww-invite__link"
              onClick={() => navigate("/enter")}
            >
              Log in
            </button>
          </p>
        )}
      </div>

      {payOpen && result && (
        <ExternalWalletPayModal packet={packet} result={result} onClose={() => setPayOpen(false)} />
      )}
    </InvitationChrome>
  )
}
