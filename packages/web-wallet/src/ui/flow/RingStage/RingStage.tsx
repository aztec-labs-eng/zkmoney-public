import { useState, type ReactNode } from "react"
import { GradientText, Icon, PrimaryGradientButton } from "@obsidion/web-ds"
import { RingLoader, type RingPhase } from "../RingLoader/RingLoader"
import { shownRing } from "./ringHandOff"
import styles from "./RingStage.module.css"

export { RING_TOKEN_SIZE, type RingPhase } from "../RingLoader/RingLoader"

const reducedMotion = () => !!window.matchMedia?.("(prefers-reduced-motion: reduce)").matches

/** For the sheet that shows the stage: its spacing and desktop width. */
export const ringStageSheet = styles.sheet

/** One phase's words and action under the ring. */
export interface RingStageBlock {
  key: string
  /** `live`: a blinking blue dot; `done`: a steady green one. */
  chip?: { text: string; tone: "live" | "done" }
  title: string
  line: string
  /** A second line under `line`, such as a time estimate. */
  subline?: string
  note?: ReactNode
  /**
   * Shows the note as a banner: yellow with a warning sign, or grey with a blinking dot: bold with
   * a yellow dot while waiting on the user, plain with a green dot while waiting on a chain.
   */
  noteTone?: "warning" | "wait" | "pending"
  button?: { label: string; onClick: () => void }
}

/**
 * A ring loader over every phase's block, stacked in one cell so the stage keeps the tallest
 * one's height and the ring never moves. On a change the old block fades out, then the `active`
 * block fades in; a newer change skips the ones before it. Arrived's block waits for the ring to
 * show arrived and close its arc.
 */
export function RingStage({
  active,
  ring,
  front,
  back,
  landing,
  blocks,
  testId,
}: {
  active: string
  ring: RingPhase
  front: ReactNode
  back: ReactNode
  landing: ReactNode
  blocks: readonly RingStageBlock[]
  testId?: string
}) {
  // The phase the ring's motion last landed on; only its animation events set it.
  const [landed, setLanded] = useState(ring)
  const ringShown = reducedMotion() ? ring : shownRing(landed, ring)
  const shownBlock = ring === "arrived" && ringShown !== "arrived" ? null : active

  return (
    <div className={styles.stage} data-testid={testId}>
      <RingLoader
        phase={ringShown}
        next={ringShown === ring ? undefined : ring}
        onLanded={setLanded}
        front={front}
        back={back}
        landing={landing}
      />
      <div className={styles.blocks}>
        {blocks.map((block) => {
          const shown = block.key === shownBlock
          return (
            <div
              key={block.key}
              className={styles.block}
              data-active={shown || undefined}
              data-arrived={(shown && ring === "arrived") || undefined}
              aria-hidden={!shown || undefined}
              inert={!shown}
            >
              {block.chip && (
                <p className={styles.chip} data-tone={block.chip.tone}>
                  {block.chip.text}
                </p>
              )}
              <div className={styles.text}>
                <GradientText size={24} weight={700}>
                  {block.title}
                </GradientText>
                <div className={styles.lines}>
                  <p className={styles.line}>{block.line}</p>
                  {block.subline && <p className={styles.line}>{block.subline}</p>}
                </div>
              </div>
              {block.note && (
                <p className={styles.note} data-tone={block.noteTone}>
                  {block.noteTone && (
                    <span className={styles.mark}>
                      <Icon name="alert-triangle" size={22} />
                      {/* The blink animates the dot; the slot's span fades it. */}
                      <span>
                        <span className={styles.dot} />
                      </span>
                    </span>
                  )}
                  <span>{block.note}</span>
                </p>
              )}
              {block.button && (
                <PrimaryGradientButton
                  className={styles.button}
                  title={block.button.label}
                  onClick={block.button.onClick}
                />
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}
