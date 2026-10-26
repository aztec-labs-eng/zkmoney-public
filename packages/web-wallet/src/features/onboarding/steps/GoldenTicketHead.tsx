import { useEffect, useLayoutEffect, useRef, useState, type ComponentProps } from "react"
import { createPortal } from "react-dom"
import { floorToCents } from "../../../ui/format"
import { deviceStorage } from "../../../platform/storage/rollupStorage"
import { senderLine } from "../../paylink/senderLine"

/** `25.00`: a ticket amount floored to cents, so it never shows more than the link pays. */
export function ticketAmountFigure(amount: bigint, decimals: number): string {
  return Number(floorToCents(amount, decimals)).toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })
}

/** `Claim @river and 25.00 DAI`; undefined until the amount is read. */
export function ticketClaimLabel(
  tag: string,
  amount: bigint | undefined,
  decimals: number,
  symbol: string,
): string | undefined {
  if (amount === undefined) return undefined
  return `Claim @${tag} and ${ticketAmountFigure(amount, decimals)} ${symbol}`
}

/** What the link pays the new account. */
export function TicketPaymentCard({
  amount,
  tokenDecimals,
  tokenSymbol,
  senderTag,
}: {
  amount: bigint
  tokenDecimals: number
  tokenSymbol: string
  senderTag?: string
}) {
  return (
    <div className="ww-ticket-payment">
      <span className="ww-ticket-payment__label">{senderLine(senderTag)}</span>
      <span className="ww-ticket-payment__amount" data-testid="paylink-signup-paylink">
        {ticketAmountFigure(amount, tokenDecimals)}{" "}
        <span className="ww-ticket-payment__symbol">{tokenSymbol}</span>
      </span>
    </div>
  )
}

/** The top of the golden ticket signup (mockup frame 6). */
export function GoldenTicketHead({
  amount,
  tokenDecimals,
  tokenSymbol,
  senderTag,
  paid,
}: {
  /** The link's amount; the payment card waits for it. */
  amount?: bigint
  tokenDecimals: number
  tokenSymbol: string
  /** The link creator's verified tag. */
  senderTag?: string
  /** No ticket: the payment pays the name's own price, so nothing here says free. */
  paid?: boolean
}) {
  return (
    <div className="ww-ticket-head">
      <span className="ww-ticket-head__badge">{paid ? "Payment link" : "Golden ticket"}</span>
      <h2 className="ww-ticket-head__title">{paid ? "Pick any name" : "Pick any name, free"}</h2>
      {amount !== undefined && (
        <TicketPaymentCard
          amount={amount}
          tokenDecimals={tokenDecimals}
          tokenSymbol={tokenSymbol}
          senderTag={senderTag}
        />
      )}
    </div>
  )
}

type TicketProps = ComponentProps<typeof GoldenTicketHead> & { tag: string }

/** The ticket itself, beside the form on a wide screen: what the link pays and the tag it names. */
export function GoldenTicketArt(props: TicketProps) {
  return (
    <div className="ww-ticket-step__art" data-testid="ticket-art" aria-hidden>
      <GoldenTicket {...props} />
    </div>
  )
}

const INTRO_SEEN_KEY = "webwallet.ticket-intro-seen"
const INTRO_MS = 2800

const matches = (query: string) => typeof matchMedia === "function" && matchMedia(query).matches

function introSeen(): boolean {
  try {
    return deviceStorage.getItem(INTRO_SEEN_KEY) === "1"
  } catch {
    return false
  }
}

/**
 * A narrow screen has no room for the art, so the ticket opens the step once per browser and leaves
 * on its own or on a tap.
 */
/** Whether the intro opens over the form: on a phone, once per device. */
export const ticketIntroShows = () => matches("(max-width: 959px)") && !introSeen()

/** The leaving animation's full run; past it the form is handed back whether or not one ran. */
const LEAVE_FALLBACK_MS = 800

/** Covers the form until opened; `onGone` hands focus back to it. */
export function GoldenTicketIntro({
  onGone,
  ...props
}: Omit<TicketProps, "tag"> & { onGone: () => void }) {
  const [state, setState] = useState<"shown" | "leaving" | "gone">(() =>
    ticketIntroShows() ? "shown" : "gone",
  )
  const done = useRef(state === "gone")
  const gone = () => {
    if (done.current) return
    done.current = true
    setState("gone")
    onGone()
  }
  const open = () => {
    if (matches("(prefers-reduced-motion: reduce)")) gone()
    else setState((now) => (now === "shown" ? "leaving" : now))
  }
  useEffect(() => {
    if (state === "gone") return
    if (state === "leaving") {
      // The animation's end dismisses the intro; a stylesheet that runs none never fires it.
      const timer = setTimeout(gone, LEAVE_FALLBACK_MS)
      return () => clearTimeout(timer)
    }
    try {
      deviceStorage.setItem(INTRO_SEEN_KEY, "1")
    } catch {
      // Unsaved: the intro shows again next time.
    }
    const timer = setTimeout(open, INTRO_MS)
    return () => clearTimeout(timer)
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once per state
  }, [state])
  // Past the art breakpoint the intro is hidden and nothing it waits for happens: hand back now.
  useEffect(() => {
    if (typeof matchMedia !== "function") return
    const wide = matchMedia("(min-width: 960px)")
    const widened = () => {
      if (wide.matches) gone()
    }
    wide.addEventListener("change", widened)
    return () => wide.removeEventListener("change", widened)
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `gone` guards itself
  }, [])
  // Inside the sheet, a fixed intro takes the sheet's box until its slide-in ends, then jumps to the
  // screen's: it renders in the dialog itself, which never moves, so it covers the screen from its
  // first frame. Outside a dialog it stays where it is.
  const anchor = useRef<HTMLSpanElement>(null)
  const [host, setHost] = useState<HTMLElement | null>()
  useLayoutEffect(() => setHost(anchor.current?.closest("dialog") ?? null), [])
  if (state === "gone") return null
  if (host === undefined) return <span ref={anchor} hidden />
  const intro = (
    <button
      type="button"
      className="zkm-btn-reset ww-ticket-intro"
      data-leaving={state === "leaving" || undefined}
      aria-label={props.paid ? "Open your payment" : "Open your golden ticket"}
      // The dialog's first focus lands here while the form behind is inert.
      data-autofocus
      onClick={open}
      onAnimationEnd={(e) => {
        if (e.target === e.currentTarget && state === "leaving") gone()
      }}
    >
      <GoldenTicket {...props} tag="" />
      <span className="ww-ticket-intro__hint">
        {props.paid ? "Tap to open your payment" : "Tap to open your ticket"}
      </span>
    </button>
  )
  return host ? createPortal(intro, host) : intro
}

function GoldenTicket({ amount, tokenDecimals, tokenSymbol, senderTag, tag, paid }: TicketProps) {
  return (
    <div className="ww-golden-ticket">
      <div className="ww-golden-ticket__top">
        <span className="ww-golden-ticket__kicker">{paid ? "Payment link" : "Golden ticket"}</span>
        <span className="ww-golden-ticket__admit">Admit one</span>
      </div>
      <div className="ww-golden-ticket__body">
        <span className="ww-golden-ticket__label">{senderLine(senderTag)}</span>
        <span className="ww-golden-ticket__amount">
          {amount === undefined ? "…" : ticketAmountFigure(amount, tokenDecimals)}
          <small>{tokenSymbol}</small>
        </span>
      </div>
      <div className="ww-golden-ticket__stub">
        <span className="ww-golden-ticket__label">Your name</span>
        <span className={`ww-golden-ticket__tag${tag ? "" : " ww-golden-ticket__tag--empty"}`}>
          @{tag || "yourname"}
          <small>.zk.money</small>
        </span>
        {!paid && <span className="ww-golden-ticket__stamp">Free</span>}
      </div>
    </div>
  )
}
