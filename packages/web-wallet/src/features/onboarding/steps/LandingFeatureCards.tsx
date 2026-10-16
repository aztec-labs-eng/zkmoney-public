import { useEffect, useState } from "react"
import arrow from "../../../assets/onboarding/landing-arrow.svg"
import savingsArt from "../../../assets/onboarding/landing-savings.webp"
import withdrawArt from "../../../assets/onboarding/landing-withdraw.webp"
import chainsArt from "../../../assets/onboarding/landing-withdraw-chains.webp"
import paylinksArt from "../../../assets/onboarding/landing-paylinks.webp"
import { apyPercent } from "../../savings/EarningsCalculator"

const CARDS: {
  eyebrow: string
  title: string
  body?: string
  art: { src: string; width: number; alt?: string }[]
  gap?: number
}[] = [
  {
    eyebrow: "SAVINGS",
    title: "Daily rewards",
    body: "Rewards tick into your balance every day. Move funds back to your spending account any time.",
    art: [{ src: savingsArt, width: 417 }],
  },
  {
    eyebrow: "WITHDRAW",
    title: "Privately",
    art: [
      { src: withdrawArt, width: 356 },
      {
        src: chainsArt,
        width: 194,
        alt: "21 available chains, including Ethereum, Arbitrum, Optimism, Hyperliquid, Solana and Arc",
      },
    ],
  },
  {
    eyebrow: "GET PAID",
    title: "Paylinks",
    body: "A link, a QR code or your @tag. Anyone can pay you without ever seeing an address.",
    art: [{ src: paylinksArt, width: 299 }],
    gap: 24,
  },
]

/**
 * Desktop landing's feature column: auto-advancing cards, with the indicator as the hold timer.
 * `apy` is Sky's live rate; without one the Savings card names the reward, not a figure.
 */
export function LandingFeatureCards({ apy }: { apy: number | undefined }) {
  // Unbounded so each step slides one card in the same direction, wrapping included.
  const [pos, setPos] = useState(0)
  const [paused, setPaused] = useState(false)
  const index = mod(pos)
  const go = (step: number) => setPos((p) => p + step)
  const zoom = useFitZoom()
  const cards =
    apy === undefined
      ? CARDS
      : CARDS.map((c) =>
          c.eyebrow === "SAVINGS"
            ? { ...c, eyebrow: "SAVINGS UP TO", title: `${apyPercent(apy)} APY` }
            : c,
        )

  return (
    <div
      className="ww-landing-cards"
      style={{ zoom }}
      role="region"
      aria-roledescription="carousel"
      aria-label="Features"
      onMouseEnter={() => setPaused(true)}
      onMouseLeave={() => setPaused(false)}
      onFocus={() => setPaused(true)}
      onBlur={() => setPaused(false)}
    >
      {/* Keyed by absolute position, so a card keeps its node and glides as pos moves. */}
      {[-2, -1, 0, 1, 2].map((offset) => {
        const at = pos + offset
        const card = cards[mod(at)]
        return (
          <div
            key={at}
            className="ww-landing-card"
            aria-hidden={offset !== 0}
            style={{ transform: `translateY(calc(${offset} * (100% + 40px)))`, gap: card.gap }}
          >
            <div className="ww-landing-card__head">
              <span className="ww-landing-card__eyebrow">{card.eyebrow}</span>
              <span className="ww-landing-card__title">{card.title}</span>
              {card.body && <span className="ww-landing-card__body">{card.body}</span>}
            </div>
            {card.art.map((a) => (
              <img key={a.src} src={a.src} alt={a.alt ?? ""} width={a.width} />
            ))}
          </div>
        )
      })}
      <div className="ww-landing-cards__nav">
        <button
          type="button"
          className="zkm-btn-reset ww-landing-cards__arrow"
          aria-label="Previous feature"
          onClick={() => go(-1)}
        >
          <img src={arrow} alt="" width={16} height={16} style={{ transform: "rotate(90deg)" }} />
        </button>
        {CARDS.map((_, i) => (
          <span
            key={i}
            aria-hidden
            className={`ww-landing-cards__seg${i === index ? " is-active" : ""}`}
          >
            {i === index && (
              <span
                key={pos}
                className="ww-landing-cards__fill"
                style={{ animationPlayState: paused ? "paused" : "running" }}
                onAnimationEnd={() => go(1)}
              />
            )}
          </span>
        ))}
        <button
          type="button"
          className="zkm-btn-reset ww-landing-cards__arrow"
          aria-label="Next feature"
          onClick={() => go(1)}
        >
          <img src={arrow} alt="" width={16} height={16} style={{ transform: "rotate(-90deg)" }} />
        </button>
      </div>
    </div>
  )
}

const mod = (n: number) => ((n % CARDS.length) + CARDS.length) % CARDS.length

/** Top bar plus the page's vertical padding: what the card must leave for the landing to fit. */
const LANDING_CHROME_HEIGHT = 204

/**
 * Scales the 489×577 card (plus its indicator) to the height the landing leaves it, capped by its
 * half of the width.
 */
function useFitZoom() {
  const fit = () =>
    Math.min((window.innerHeight - LANDING_CHROME_HEIGHT) / 577, (window.innerWidth * 0.45) / 549)
  const [zoom, setZoom] = useState(fit)
  useEffect(() => {
    const onResize = () => setZoom(fit())
    window.addEventListener("resize", onResize)
    return () => window.removeEventListener("resize", onResize)
  }, [])
  return zoom
}
