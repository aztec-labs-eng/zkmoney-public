import { Icon, PrimaryGradientButton, RowChevron } from "@obsidion/web-ds"
import { fmt } from "../../../lib/fmt"
import { CornerButton } from "../../../ui/flow/CornerButton/CornerButton"
import { Modal } from "../../../ui/Modal"
import { privacyHeadline } from "../privacyRing"
import type { PrivacyLevel, PrivacyRing, RingTone } from "../privacyRing"
import type { WalletPrivacy } from "../useWalletPrivacy"
import copy from "./PrivacyBadge.copy"
import styles from "./PrivacyBadge.module.css"

const TONE_COLOR: Record<RingTone, string> = {
  clear: "#56e79d",
  weak: "#f5c542",
  direct: "#fe708b",
  unknown: "#6b6f80",
}

/** The ring's segment `i`, clockwise from the top. */
const arc = (i: number) => {
  const r = 7
  const point = (deg: number) => {
    const rad = ((deg - 90) * Math.PI) / 180
    return `${9 + r * Math.cos(rad)} ${9 + r * Math.sin(rad)}`
  }
  return `M ${point(i * 120 + 8)} A ${r} ${r} 0 0 1 ${point(i * 120 + 112)}`
}

function Ring({ colors, size }: { colors: string[]; size: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 18 18" fill="none" aria-hidden>
      {colors.map((color, i) => (
        <path key={i} d={arc(i)} stroke={color} strokeWidth={3} strokeLinecap="round" />
      ))}
    </svg>
  )
}

/** Three arcs clockwise from the top: linked to you, onchain activity, public identity. */
export function PrivacyRingIcon({ ring, size = 18 }: { ring: PrivacyRing; size?: number }) {
  const tones = [ring.linked, ring.activity, ring.identity]
  return <Ring colors={tones.map((tone) => TONE_COLOR[tone])} size={size} />
}

/** The ring with one segment marked: the question that segment answers. */
function SegmentGlyph({
  segment,
  size,
  color = "#fdfdfd",
}: {
  segment: number
  size: number
  color?: string
}) {
  const colors = [0, 1, 2].map((i) => (i === segment ? color : TONE_COLOR.unknown))
  return <Ring colors={colors} size={size} />
}

const QUESTIONS = (["used", "transactions", "named"] as const).map(
  (field) => [copy.questions[field].question, copy.questions[field].body, field] as const,
)

/** A saved wallet's ring and label, inside its row's button. */
export function PrivacyBadge({ privacy }: { privacy: WalletPrivacy }) {
  return (
    <span className="ww-privacy" data-level={privacy.level}>
      <PrivacyRingIcon ring={privacy.ring} />
      <span className="ww-privacy__label">{copy.level[privacy.level]}</span>
      <RowChevron />
    </span>
  )
}

/**
 * What each segment of a {@link PrivacyBadge} found, shown while the badge is hovered. A sibling of
 * the row's button, since it holds buttons of its own.
 */
export function PrivacyPopover({
  privacy,
  onRated,
  onFresh,
}: {
  privacy: WalletPrivacy
  onRated: () => void
  onFresh?: () => void
}) {
  const { ring, withdrawals } = privacy
  const headline = privacyHeadline(ring)
  // A saved recipient withdrawn to elsewhere has no count here.
  const counted = withdrawals > 0
  const title =
    headline.line === "withdrew" && counted
      ? fmt(copy.headline.withdrew, { n: withdrawals })
      : headline.line === "withdrew"
      ? copy.headline.withdrewUncounted
      : copy.headline[headline.line]
  const rows = [
    ring.linked === "direct"
      ? copy.answers.deposited
      : ring.linked === "weak"
      ? counted
        ? fmt(copy.answers.withdrew, { n: withdrawals })
        : copy.answers.withdrewUncounted
      : copy.answers.notUsed,
    copy.answers.transactions[ring.activity],
    ring.identity === "clear"
      ? copy.answers.notNamed
      : privacy.etherfi
      ? copy.etherfiName
      : privacy.ensName ?? copy.answers.named,
  ]
  const tones = [ring.linked, ring.activity, ring.identity]
  return (
    <span className="ww-privacy__pop" role="tooltip">
      {/* Only a direct link colors the text; the ring and glyphs carry every other tone. */}
      <b data-tone={headline.tone === "direct" ? "direct" : undefined}>
        <PrivacyRingIcon ring={ring} />
        {title}
      </b>
      <span className="ww-privacy__rows">
        {QUESTIONS.map(([question, , field], i) => (
          <span key={field} className="ww-privacy__row">
            <SegmentGlyph segment={i} size={14} color={TONE_COLOR[tones[i]!]} />
            {question}
            <small data-tone={tones[i] === "direct" ? "direct" : undefined}>{rows[i]}</small>
          </span>
        ))}
      </span>
      <span className="ww-privacy__actions">
        <button type="button" className="zkm-btn-reset ww-privacy__rated" onClick={onRated}>
          <Icon name="question-circle" size={12} />
          {copy.rated}
        </button>
        {onFresh && privacy.level !== "High" && (
          <button type="button" className="zkm-btn-reset ww-privacy__fresh" onClick={onFresh}>
            {copy.fresh}
          </button>
        )}
      </span>
    </span>
  )
}

const CLEAR: PrivacyRing = { linked: "clear", activity: "clear", identity: "clear" }
/** A ring for each level, as the sheet shows it. */
const LEVEL_RINGS: [PrivacyLevel, PrivacyRing][] = [
  ["High", CLEAR],
  ["Medium", { ...CLEAR, activity: "weak" }],
  ["Low", { linked: "direct", activity: "weak", identity: "clear" }],
]

/** What the ring's segments ask, and how their answers add up to a level. */
export function PrivacyRatedModal({ onClose }: { onClose: () => void }) {
  return (
    <Modal
      variant="bare"
      label={copy.rated}
      className={`ww-deposit-warning ww-deposit-sheet ${styles.sheet}`}
      onClose={onClose}
    >
      <div className="ww-deposit-warning__close">
        <CornerButton kind="close" label={copy.close} onClick={onClose} />
      </div>
      <div className={styles.head}>
        <PrivacyRingIcon ring={CLEAR} size={56} />
        <h2>{copy.rated}</h2>
        <p>{copy.ratedBody}</p>
      </div>
      <span className={styles.legend}>
        <span data-tone="clear">{copy.legend.clear}</span>
        <span data-tone="weak">{copy.legend.weak}</span>
        <span data-tone="direct">{copy.legend.direct}</span>
      </span>
      <div className={`${styles.card} ${styles.questions}`}>
        {QUESTIONS.map(([question, body], i) => (
          <span key={question} className={styles.question}>
            <SegmentGlyph segment={i} size={20} />
            <span>
              <b>{question}</b>
              <small>{body}</small>
            </span>
          </span>
        ))}
      </div>
      <div className={`${styles.card} ${styles.levels}`}>
        {LEVEL_RINGS.map(([level, ring]) => (
          <span key={level} className={styles.level}>
            <PrivacyRingIcon ring={ring} size={18} />
            {copy.level[level]}
            <small>{copy.rule[level]}</small>
          </span>
        ))}
      </div>
      <PrimaryGradientButton
        title={copy.gotIt}
        onClick={onClose}
        className="ww-deposit-sheet__cta"
      />
    </Modal>
  )
}
