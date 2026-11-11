import { formatUnits } from "viem"
import { DEFAULT_DECIMALS } from "@obsidion/core/constants"
import { fmt } from "../../../../lib/fmt"
import { usdFigure } from "../../../../ui/format"
import type { SpeedChoice, SpeedOutcome } from "../../speedChoice"
import { etaLabel } from "../../WithdrawalSpeedPicker"
import speedCopy from "../../WithdrawalSpeedPicker.copy"
import type { WithdrawalSpeed } from "../../WithdrawalSpeedPicker"
import copy from "./SpeedCards.copy"
import styles from "./SpeedCards.module.css"

interface Card {
  id: WithdrawalSpeed
  title: string
  /** The eta, then what it costs or when it starts. */
  lines: string[]
  /** Why the card is off, under its lines. */
  note?: string
  disabled?: boolean
}

/**
 * Fast and Standard as two radio cards, Fast first, rendered in every state so the step keeps its
 * height. Both are off while the first offer loads; without an offer Fast is off and Standard is
 * chosen; a tip that cannot be paid leaves Fast off, saying why under its tip.
 */
export function SpeedCards({ choice, outcome }: { choice: SpeedChoice; outcome: SpeedOutcome }) {
  const { offer, loading, settled } = choice
  const standard = (seconds: number) => [etaLabel(seconds), copy.onceConfirmed]
  const standardLines = choice.eta && standard(choice.eta.standardSeconds)
  let cards: Card[]
  let selected: WithdrawalSpeed | undefined
  if (!offer && loading) {
    cards = [
      { id: "faster", title: copy.fast, lines: [speedCopy.checking], disabled: true },
      {
        id: "standard",
        title: copy.standard,
        lines: standardLines ?? [speedCopy.checking],
        disabled: true,
      },
    ]
  } else if (!offer) {
    cards = [
      { id: "faster", title: copy.fast, lines: [copy.unavailable], disabled: true },
      { id: "standard", title: copy.standard, lines: standardLines ?? [] },
    ]
    selected = "standard"
  } else {
    cards = [
      {
        id: "faster",
        title: copy.fast,
        lines: settled
          ? [etaLabel(offer.tippedEtaSeconds)]
          : [
              etaLabel(offer.tippedEtaSeconds),
              fmt(copy.tip, {
                tip: usdFigure(formatUnits(offer.proverTip, DEFAULT_DECIMALS)),
              }),
            ],
        note: outcome.blocked,
        disabled: settled || !!outcome.blocked,
      },
      {
        id: "standard",
        title: copy.standard,
        lines: standard(offer.standardEtaSeconds),
        disabled: settled,
      },
    ]
    selected = settled ? "faster" : choice.speed
  }
  return (
    <div className={styles.speeds} role="radiogroup" aria-label={copy.label}>
      {cards.map((card) => (
        <SpeedCard
          key={card.id}
          card={card}
          checked={card.id === selected}
          onPick={card.disabled ? undefined : () => choice.setSpeed(card.id)}
        />
      ))}
      {offer && settled && <small className={styles.speedNote}>{speedCopy.settledNote}</small>}
    </div>
  )
}

function SpeedCard({
  card,
  checked,
  onPick,
}: {
  card: Card
  checked: boolean
  onPick?: () => void
}) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={checked}
      className={`zkm-btn-reset ${styles.speed}`}
      data-testid={card.id === "faster" ? "withdraw-speed-fast" : "withdraw-speed-standard"}
      disabled={card.disabled || !onPick}
      onClick={onPick}
    >
      <span className={styles.speedText}>
        <b>{card.title}</b>
        {card.lines.map((line) => (
          <small key={line}>{line}</small>
        ))}
        {/* Every state keeps two lines, so the card's height never moves as the offer loads. */}
        {card.lines.length < 2 && <small aria-hidden>{"\u00a0"}</small>}
        {card.note && <small>{card.note}</small>}
      </span>
      <span className={styles.radio} aria-hidden />
    </button>
  )
}
