/**
 * `/pay/<tag>[#<fragment>]` and the older `/request#<fragment>` — the payer's entry to a payee.
 * A fragment is a request link; a bare `/pay/<tag>` is a standing any-amount request for the tag.
 *
 * With a local identity the packet validates (legacy links tolerated) and the flow hands off to the
 * existing contact send screen with the request in router state. Without one it renders the
 * invitation landing: the requested amount over a choice of how to pay — signing up, or an external
 * L1 wallet paying the requester's SIPA deposit address.
 *
 * The SIPA resolve runs on mount, outside AccountGate. A signed-out visit boots no PXE until it
 * picks zk.money. An embedded `sipaAddress` is the payee directly; without one the tag CCIP-resolves
 * to one.
 * No XMTP signal is sent (no account) — the requester's wallet joins the claimed deposit to the
 * minted row by address instead.
 */
import { useEffect, useMemo, useRef, useState } from "react"
import { Outlet, useLocation, useNavigate, useParams } from "react-router-dom"
import { createPublicClient, type PublicClient } from "viem"
import type { AztecNode } from "@aztec-labs/aztec.js/node"
import {
  decodeRequestInline,
  normalizeTag,
  type RegistryTagResolution,
  type RequestInlinePacket,
  useStore,
  serviceStatus,
} from "@obsidion/front-core"
import type { ChainIdentity } from "@obsidion/core/types"
import { bundledLinkLocator, decodeLinkFragment, LinkKind } from "@obsidion/sdk"
import {
  Card,
  Icon,
  PrimaryGradientButton,
  ScreenNavBar,
  Spinner,
  TopNavIconButton,
} from "@obsidion/web-ds"
import { l1Transport, type WebWalletConfig } from "../../config/env"
import { fireEvent, reportLanding, requestAmountBucket } from "../../lib/analytics"
import { usdBalance } from "../../ui/format"
import { useBack, useLinkSharing } from "../../ui/hooks"
import { BootSplash, usePxeBoot, verifiedIdentity } from "../../ui/PxeBoot"
import { enteredIdentity } from "../../session/account"
import { useSession } from "../../session/session"
import { resolveTagForCommit } from "../contacts/registryResolution"
import { recipientNotUpgradedCopy } from "../migration/upgradeCopy"
import { InvitationChrome } from "../onboarding/InvitationChrome"
import { resolveAccountlessRequest } from "./accountlessRequest"
import type { AccountlessResolveResult, TagWarning } from "./accountlessRequest"
import { RequestDecimalsMismatchError, RequesterNotUpgradedError } from "./accountlessRequestErrors"
import type { RequesterMismatch } from "./accountlessRequestErrors"
import { ExternalWalletPayModal } from "./ExternalWalletPayModal"
import { loadDepositTokens } from "../sipa/loadDepositFacts"
import { requestAmountDisplay, validateRequestPacket, type RequestLinkProblem } from "./requestLink"
import { fireRequestOpened } from "./requestOpened"
import { resolveShortRequest } from "./shortRequestLink"
import { useShortLinkLookup } from "../shortLinks"
import type { PayStart } from "./payStart"
import { errorMessage } from "../../errors/catalog"
import { fmt } from "../../lib/fmt"
import copy from "./RequestLandingScreen.copy"
import { WalletError, type ErrorCode } from "@obsidion/core/errors"
import { useOpened } from "../../ui/useScreenFlow"

/** The registry's identity refusals: final, so the payer gets no retry. */
const FINAL_CODES: ReadonlySet<ErrorCode> = new Set(["contact.unregistered"])

/**
 * `unknownPayee`: a pay page for a tag nobody holds, such as a mistyped `<tag>.zk.money`.
 * `notUpgraded`: the payee's tag is still on a retired rollup.
 * `requesterMoved` / `requesterChanged` / `requesterMismatch`: the tag names another L2 account
 * than the link pins: the requester's own new one, another owner's, or one whose history could not
 * be read.
 */
type PayProblem =
  | RequestLinkProblem
  | "unknownPayee"
  | "notUpgraded"
  | "requesterMoved"
  | "requesterChanged"
  | "requesterMismatch"

const MISMATCH_PROBLEM: Record<RequesterMismatch, PayProblem> = {
  moved: "requesterMoved",
  otherOwner: "requesterChanged",
  unknown: "requesterMismatch",
}

/** A refused link offers no way on to pay, since the send sheet refuses it too. */
const refusesRequester = (problem: PayProblem) => Object.values(MISMATCH_PROBLEM).includes(problem)

function problemCopy(problem: PayProblem, tag: string): string {
  return problem === "notUpgraded"
    ? recipientNotUpgradedCopy.payPageHint
    : fmt(copy.problems[problem], { tag })
}

function tagWarningCopy(warning: TagWarning, tag: string): string {
  return fmt(copy.tagWarning, {
    warning:
      warning === "notUpgraded"
        ? recipientNotUpgradedCopy.title(tag)
        : fmt(copy.tagWarnings[warning], { tag }),
  })
}

/**
 * The rollup the active tab verified before the app mounted. Without one (demo mode) it reads the
 * identity the boot would: L1's, with the default node standing in when L1 gives no answer.
 */
async function rollupAddressOf(
  config: WebWalletConfig,
  node: AztecNode,
  identity?: ChainIdentity,
): Promise<string> {
  return (identity ?? (await verifiedIdentity(config, node))).rollupAddress
}

/** 31 random bytes: a valid field, so it can ride in the transfer's request reference. */
function standingRequestId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(31))
  return `0x00${Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("")}`
}

/** The request a bare `/pay/<tag>` stands for: any amount, to the tag, on this wallet's network. */
function standingPacket(tag: string): RequestInlinePacket {
  return { requestId: standingRequestId(), requesterTag: tag, amountAtomic: 0n, networkId: "" }
}

/** A standing packet is built here, so only its payee can be wrong. */
async function standingProblem(payee: Promise<RegistryTagResolution>): Promise<PayProblem | null> {
  const { status } = await payee
  if (status === "staleRollup") return "notUpgraded"
  return status === "resolved" ? null : "unknownPayee"
}

/** A short link's fragment is looked up on chain first and replaced by the request it stands for. */
export function RequestLandingScreen(props: {
  node: AztecNode
  chainIdentity?: ChainIdentity
  /** The request the page opens on, with its pay sheet open, in place of the link's. */
  start?: PayStart
}) {
  const location = useLocation()
  const fragment = location.hash.replace(/^#/, "")
  const short = useMemo(() => {
    const decoded = decodeLinkFragment(fragment)
    return decoded?.kind === LinkKind.Request ? decoded.seed : undefined
  }, [fragment])
  return short ? (
    <ShortRequestLanding seed={short} node={props.node} />
  ) : (
    <FullRequestLanding {...props} />
  )
}

function ShortRequestLanding({ seed, node }: { seed: Uint8Array; node: AztecNode }) {
  const navigate = useNavigate()
  const location = useLocation()
  // A browser with no account has no contract service; the bundled class still finds the link.
  const { contractService } = useSession()
  const contracts = useStore(contractService, serviceStatus) === "ready"
  const resolve = useMemo(
    () => async () =>
      resolveShortRequest(
        node,
        contracts ? await contractService.ready() : bundledLinkLocator,
        seed,
      ),
    [node, contracts, contractService, seed],
  )
  useShortLinkLookup(resolve, (fragment) =>
    navigate(`${location.pathname}#${fragment}`, { replace: true, state: location.state }),
  )
  return <BootSplash />
}

function FullRequestLanding({
  node,
  chainIdentity,
  start,
}: {
  node: AztecNode
  chainIdentity?: ChainIdentity
  start?: PayStart
}) {
  const location = useLocation()
  const { tag: pathTag } = useParams()
  const fragment = location.hash.replace(/^#/, "")
  // A signed-in payer who chose the Ethereum route on the send sheet comes back here for it.
  const forceExternal = (location.state as { external?: boolean } | null)?.external === true
  const session = useSession()
  const entered = enteredIdentity(
    useStore(session.identity),
    useStore(session.device).passkeyMap,
    session.page.config.rpId,
  )
  const standing = !fragment && pathTag !== undefined
  const read = useMemo(() => {
    // The link is untrusted input and its tag derives the payee's deposit address, which a
    // different case resolves differently. Fold it once here so every consumer agrees; a tag
    // that does not survive the fold is a link nothing can be paid to.
    const payee = pathTag === undefined ? undefined : normalizeTag(pathTag)
    if (payee === null) return null
    if (!fragment) return payee ? standingPacket(payee) : null
    try {
      const decoded = decodeRequestInline(fragment)
      const requesterTag = normalizeTag(decoded.requesterTag)
      // A pay page names one payee; a fragment for another is not its request.
      if (requesterTag === null || (payee && payee !== requesterTag)) return null
      return { ...decoded, requesterTag }
    } catch {
      return null
    }
  }, [fragment, pathTag])
  const packet = start?.request ?? read
  // The loaded identity + MSK breadcrumb. An unreadable identity is not a visitor's.
  const identity = entered ?? undefined
  const hasIdentity = entered !== null

  if (!packet) {
    return (
      <div className="ww-flow" data-testid="request-unreadable">
        <ScreenNavBar title="Payment request" />
        <Card style={{ marginTop: 24 }}>
          <div style={{ textAlign: "center", padding: "18px 8px", color: "var(--text-secondary)" }}>
            This payment-request link could not be read.
          </div>
        </Card>
      </div>
    )
  }
  // The payee sees their own page as payers do, with a way to share it.
  const own = !!identity?.handle && normalizeTag(identity.handle) === packet.requesterTag
  return hasIdentity && !forceExternal && !own && !start ? (
    <SignedInRequest
      packet={packet}
      standing={standing}
      node={node}
      chainIdentity={chainIdentity}
    />
  ) : (
    // Another payee starts afresh: no quote or open sheet carries over from the last one.
    <AccountlessRequest
      key={`${packet.requesterTag}#${fragment}`}
      packet={packet}
      standing={standing}
      node={node}
      chainIdentity={chainIdentity}
      signedIn={hasIdentity && !own}
      own={own}
      start={start}
    />
  )
}

/** Validate, then hand off to the existing contact send flow with the request in router state.
 *  `standing`: the packet was built here, not read from a link, so only its payee is checked. */
function SignedInRequest({
  packet,
  standing,
  node,
  chainIdentity,
}: {
  packet: RequestInlinePacket
  standing: boolean
  node: AztecNode
  chainIdentity?: ChainIdentity
}) {
  const navigate = useNavigate()
  const { pathname, hash } = useLocation()
  const { page } = useSession()
  const { config, chain } = page
  const [problem, setProblem] = useState<PayProblem | null>(null)
  const [error, setError] = useState<string>()

  // eslint-disable-next-line local/effect-hook -- ZKM-1806
  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        const [rollupAddress, tuple, payeeProblem] = await Promise.all([
          rollupAddressOf(config, node, chainIdentity),
          chain.oxideTuple.read(),
          standing
            ? standingProblem(resolveTagForCommit({ config, chain }, packet.requesterTag))
            : null,
        ])
        if (cancelled) return
        const found = standing
          ? payeeProblem
          : validateRequestPacket(packet, {
              rollupAddress,
              l2Token: tuple.l2Token,
              requireTokenAddress: false,
            })
        if (cancelled) return
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
              requesterPin: packet.requesterAddress ?? packet.requesterPin,
              note: packet.note,
              link: `${pathname}${hash}`,
              standing,
            },
          },
        })
      } catch (e) {
        console.error("Payment request failed to open", e)
        if (!cancelled) setError("Couldn't open this request. Check your connection and reload.")
      }
    })()
    return () => {
      cancelled = true
    }
  }, [packet, standing, navigate, config, chain])

  // The boot screen stays up through the hand-off to the send screen.
  if (!problem && !error) return <BootSplash />
  return (
    <InvitationChrome page={page}>
      <div
        className="ww-invite__content ww-invite__content--landing ww-invite__content--pay"
        data-testid="request-problem"
      >
        <PaySummary packet={packet} />
        <p className="ww-paylink-summary__caption">
          {problem ? problemCopy(problem, packet.requesterTag) : error}
        </p>
      </div>
    </InvitationChrome>
  )
}

/** The payee and amount a pay page opens with. */
function PaySummary({ packet }: { packet: RequestInlinePacket }) {
  const amountDisplay = requestAmountDisplay(packet)
  return (
    <>
      <span className="ww-invite-modal-badge">
        <Icon name="arrow-down" size={32} color="#fff" />
      </span>
      <div className="ww-paylink-summary">
        <span className="ww-paylink-summary__label">Pay @{packet.requesterTag}</span>
        <span className="ww-paylink-summary__amount">
          {amountDisplay ? usdBalance(amountDisplay) : "Any amount"}
        </span>
        {packet.note && <span className="ww-paylink-summary__note">{packet.note}</span>}
      </div>
    </>
  )
}

type PanelState =
  | { kind: "loading" }
  | { kind: "problem"; problem: PayProblem }
  | { kind: "resolved"; result: AccountlessResolveResult }
  | { kind: "error"; final?: string }

/** No-account surface: the requested amount over the two ways to pay it. */
/** `signedIn`: the payer has an account and picked the Ethereum route on the send sheet, so the
 *  signup option and the log-in foot make no sense; the foot offers the send sheet instead.
 *  `own`: the payee on their own page; the foot shares it. */
function AccountlessRequest({
  packet,
  standing,
  node,
  chainIdentity,
  signedIn = false,
  own = false,
  start,
}: {
  packet: RequestInlinePacket
  standing: boolean
  own?: boolean
  node: AztecNode
  chainIdentity?: ChainIdentity
  signedIn?: boolean
  start?: PayStart
}) {
  const navigate = useNavigate()
  const { pathname, hash } = useLocation()
  const { page } = useSession()
  const { config, chain } = page
  const here = `${pathname}${hash}`
  const back = useBack("/")
  const { copied, share } = useLinkSharing(
    `${window.location.origin}${here}`,
    `Pay @${packet.requesterTag}`,
  )
  const [signup, setSignup] = useState(false)
  // "Pay with zk.money" asks first whether an account exists: Log in leads, Create account follows.
  const [receiving, setReceiving] = useState(false)
  const [payOpen, setPayOpen] = useState(!!start)
  // The start holds for the sheet's first showing only.
  const [opening, setOpening] = useState(start)
  const { startBoot } = usePxeBoot(page)
  const [state, setState] = useState<PanelState>({ kind: "loading" })
  const [attempt, setAttempt] = useState(0)
  // Keep one resolution per packet/attempt, including development effect replay.
  const inFlight = useRef<{
    packet: RequestInlinePacket
    attempt: number
    result: Promise<PanelState>
  } | null>(null)

  const amountDisplay = requestAmountDisplay(packet)
  const amount = amountDisplay ? Number(amountDisplay) : 0
  const source = standing ? "pay_page" : "link"

  // The signed-in path reports its open from the contact send screen; this covers the
  // accountless surface (usually a no-op — a visitor with no account granted no consent).
  useOpened(() => {
    if (!own && !signedIn) reportLanding(standing ? "pay_page" : "request_link")
    if (!own) fireRequestOpened(source, packet.requestId, amount, packet.requesterTag)
  })

  // eslint-disable-next-line local/effect-hook -- ZKM-1806
  useEffect(() => {
    if (inFlight.current?.packet !== packet || inFlight.current.attempt !== attempt) {
      const stub = page.loaders.accountlessRequest
      const result = (async (): Promise<PanelState> => {
        if (stub) return { kind: "resolved", result: await stub(packet) }
        try {
          const publicClient = createPublicClient({
            chain: config.l1Chain,
            transport: l1Transport(config),
          }) as PublicClient
          const tupleRead = chain.oxideTuple.read()
          // A standing packet's one check is its payee, which the resolve pins too, so both start at
          // once. A link's checks come first: an expired link must not reach the CCIP resolver.
          const page = { config, chain }
          const payee = standing ? resolveTagForCommit(page, packet.requesterTag) : undefined
          const resolve = () =>
            Promise.all([tupleRead, loadDepositTokens(page)]).then(([tuple, accepted]) =>
              resolveAccountlessRequest(packet, {
                tuple,
                publicClient,
                resolveRequester: payee ? () => payee : (tag) => resolveTagForCommit(page, tag),
                chainId: config.l1ChainId,
                acceptedTokens: accepted.options.map((t) => t.address),
              }),
            )
          const early = standing ? resolve() : undefined
          early?.catch(() => {})
          const [rollupAddress, tuple, payeeProblem] = await Promise.all([
            rollupAddressOf(config, node, chainIdentity),
            tupleRead,
            payee ? standingProblem(payee) : null,
          ])
          const problem = standing
            ? payeeProblem
            : validateRequestPacket(packet, {
                rollupAddress,
                l2Token: tuple.l2Token,
                requireTokenAddress: true,
              })
          if (problem) return { kind: "problem", problem }
          return { kind: "resolved", result: await (early ?? resolve()) }
        } catch (e) {
          if (e instanceof RequestDecimalsMismatchError) {
            return { kind: "problem", problem: "wrongToken" }
          }
          if (e instanceof RequesterNotUpgradedError) {
            return { kind: "problem", problem: "notUpgraded" }
          }
          if (e instanceof WalletError && e.code === "contact.requestMismatch") {
            const reason = e.data?.reason as RequesterMismatch
            return { kind: "problem", problem: MISMATCH_PROBLEM[reason] }
          }
          // Registry identity failures are final and worded for the payer; anything else retries and
          // stays in the console.
          if (e instanceof WalletError && FINAL_CODES.has(e.code)) {
            return { kind: "error", final: errorMessage(e) }
          }
          console.error("Payment address failed to prepare", e)
          return { kind: "error" }
        }
      })()
      inFlight.current = { packet, attempt, result }
    }
    // Each effect run observes the shared operation through its own cancellable subscription.
    let cancelled = false
    // A requote keeps the last quote on screen, so an open pay sheet stays open.
    setState((s) => (s.kind === "resolved" ? s : { kind: "loading" }))
    void inFlight.current.result.then((next) => {
      if (!cancelled) setState(next)
    })
    return () => {
      cancelled = true
    }
  }, [packet, standing, attempt, config, chain])

  const result = state.kind === "resolved" ? state.result : undefined
  const refused = state.kind === "problem" && refusesRequester(state.problem)
  // Signup returns here, where the identity branch hands the request to the send flow.
  const startSignup = () => {
    setSignup(true)
    navigate({ pathname, hash }, { replace: true, state: { next: here } })
  }

  if (signup) {
    return (
      <InvitationChrome page={page}>
        <Outlet />
      </InvitationChrome>
    )
  }

  if (receiving) {
    return (
      <InvitationChrome page={page}>
        <div className="ww-invite__content ww-invite__content--landing ww-invite__content--pay">
          <span className="ww-invite-modal-badge">
            <Icon name="arrow-down" size={32} color="#fff" />
          </span>
          <div className="ww-paylink-summary">
            <span className="ww-paylink-summary__label">Pay @{packet.requesterTag}</span>
            <span className="ww-paylink-summary__amount">
              {amountDisplay ? usdBalance(amountDisplay) : "Any amount"}
            </span>
          </div>
          <p className="ww-paylink-summary__caption">Pay with zk.money</p>
          <div className="ww-claim-modal__actions">
            <PrimaryGradientButton
              title="Log in"
              onClick={() => navigate("/enter", { state: { next: here } })}
            />
            <PrimaryGradientButton
              title="Create account"
              buttonStyle="dark"
              onClick={startSignup}
            />
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
    if (result.deployment === "expired") return "This link has expired."
    return signedIn ? copy.publicPayment : copy.feePublicPayment
  }

  return (
    <InvitationChrome page={page}>
      <div className="ww-invite__content ww-invite__content--landing ww-invite__content--pay">
        {own && (
          <span className="ww-invite__back">
            <TopNavIconButton icon="arrow-left" ariaLabel="Back" onClick={back} />
          </span>
        )}
        <PaySummary packet={packet} />

        {state.kind === "problem" ? (
          <p className="ww-paylink-summary__caption">
            {problemCopy(state.problem, packet.requesterTag)}
          </p>
        ) : (
          <>
            {/* The @tag is the identity on screen but the link supplies the address — an
                unchecked @tag has to outrank the pay buttons, not sit under them. */}
            {result?.tagWarning && (
              <p className="ww-invite-modal-error" role="alert">
                {tagWarningCopy(result.tagWarning, packet.requesterTag)}
              </p>
            )}
            <p className="ww-paylink-summary__caption">
              {signedIn ? copy.feeApplies : copy.chooseHowToPay}
            </p>
            <div className="ww-paymethods">
              {!signedIn && (
                <button
                  type="button"
                  className="zkm-btn-reset zkm-pressable ww-deposit__connect ww-paymethod ww-paymethod--best"
                  onClick={() => {
                    // Both ways on from here need the PXE.
                    startBoot()
                    setReceiving(true)
                  }}
                >
                  <span className="ww-paymethod__flag">
                    <span>Free</span>
                  </span>
                  <span className="ww-deposit__connect-icon">
                    <Icon name="lock-shield" size={24} color="#fff" />
                  </span>
                  <span className="ww-deposit__connect-text">
                    <b>Pay with zk.money</b>
                    <span>No fee. Your payment stays private.</span>
                  </span>
                  <Icon name="chevron-right" size={16} color="var(--text-secondary)" />
                </button>
              )}

              <button
                type="button"
                className="zkm-btn-reset zkm-pressable ww-deposit__connect ww-paymethod"
                data-testid="request-pay-with-wallet"
                disabled={!result}
                onClick={() => setPayOpen(true)}
              >
                <span className="ww-deposit__connect-icon">
                  <Icon name="wallet" size={24} color="#fff" />
                </span>
                <span className="ww-deposit__connect-text">
                  <b>{copy.payWithWallet}</b>
                  <span>{externalCaption()}</span>
                </span>
                {state.kind === "loading" ? (
                  <Spinner size={16} />
                ) : result ? (
                  <Icon name="chevron-right" size={16} color="var(--text-secondary)" />
                ) : null}
              </button>
            </div>

            {state.kind === "error" &&
              (state.final ? (
                <p className="ww-invite-modal-error" role="alert">
                  {state.final}
                </p>
              ) : (
                <PrimaryGradientButton title="Try again" onClick={() => setAttempt((n) => n + 1)} />
              ))}
          </>
        )}

        {refused ? null : own ? (
          <>
            <p className="ww-invite-modal-foot">
              This is a preview of your pay page. Share it to get paid.
            </p>
            <PrimaryGradientButton
              title={copied ? "Copied" : "Share link"}
              leadingIcon="share"
              buttonStyle="dark"
              onClick={() => void share()}
            />
          </>
        ) : signedIn ? (
          <p className="ww-invite-modal-foot">
            {/* Dropping the route flag re-enters the identity branch, which hands the request back
                to the send sheet with its state rebuilt from the packet. */}
            <button
              type="button"
              className="zkm-btn-reset ww-invite__link"
              onClick={() => navigate({ pathname, hash }, { replace: true })}
            >
              Pay with zk.money instead
            </button>
          </p>
        ) : (
          <p className="ww-invite-modal-foot">
            Already have zk.money?{" "}
            <button
              type="button"
              className="zkm-btn-reset ww-invite__link"
              onClick={() => navigate("/enter", { state: { next: here } })}
            >
              Log in
            </button>
          </p>
        )}
      </div>

      {payOpen && result && (
        <ExternalWalletPayModal
          packet={packet}
          result={result}
          start={opening}
          onClose={() => {
            setOpening(undefined)
            setPayOpen(false)
          }}
          onFeeChanged={() => setAttempt((n) => n + 1)}
          onPaid={
            own
              ? undefined
              : () =>
                  fireEvent("request_paid", {
                    source,
                    route: "ethereum",
                    amount_bucket: requestAmountBucket(amount),
                  })
          }
        />
      )}
    </InvitationChrome>
  )
}
