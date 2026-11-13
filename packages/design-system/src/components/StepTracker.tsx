import { ProgressSpinner } from "./Effects"
import { Icon } from "./Icon"

export interface TrackerStep {
  label: string
  detail?: string
  state: "done" | "current" | "todo"
  /** Current step's detail: warning for a delay or a closed prompt, error for a wrong pick. */
  tone?: "progress" | "warning" | "error"
  /** The current step failed, so its ring stops turning. */
  failed?: boolean
}

export interface StepTrackerProps {
  /** Caption, e.g. "Adding a backup". */
  label: string
  /** e.g. "Step 2 of 4". */
  progress: string
  steps: TrackerStep[]
}

// ProgressSpinner draws its track at 25% of `color`: 0.48 and 0.72 give Figma's 12% and 18% rings.
function StepMark({ state, failed }: Pick<TrackerStep, "state" | "failed">) {
  return (
    <span className="zkm-step-tracker__mark" aria-hidden>
      {state === "done" ? (
        <Icon name="check-circle-fill" size={24} color="var(--accent-green)" />
      ) : state === "current" ? (
        <ProgressSpinner
          size={24}
          thickness={2.64}
          progress={0.7}
          cap="butt"
          gradient
          spin={!failed}
          color="rgba(var(--ink-rgb), 0.48)"
        />
      ) : (
        <ProgressSpinner
          size={24}
          thickness={2.64}
          progress={0}
          cap="butt"
          color="rgba(var(--ink-rgb), 0.72)"
        />
      )}
    </span>
  )
}

function detailTone(step: TrackerStep) {
  return step.state === "current" ? step.tone ?? "progress" : "muted"
}

/** A flow's steps on a rail: done ones ticked, the current one ringed, the rest grayed. */
export function StepTracker({ label, progress, steps }: StepTrackerProps) {
  return (
    <div className="zkm-step-tracker">
      <div className="zkm-step-tracker__head">
        <span className="zkm-step-tracker__label">{label}</span>
        <span className="zkm-step-tracker__progress">{progress}</span>
      </div>
      <ol className="zkm-step-tracker__steps">
        {steps.map((step, i) => (
          <li
            key={i}
            className={`zkm-step-tracker__step zkm-step-tracker__step--${step.state}`}
            aria-current={step.state === "current" ? "step" : undefined}
          >
            <span className="zkm-step-tracker__rail">
              <StepMark state={step.state} failed={step.failed} />
              {i < steps.length - 1 && <span className="zkm-step-tracker__line" />}
            </span>
            <span className="zkm-step-tracker__text">
              <span className="zkm-step-tracker__step-label">{step.label}</span>
              {step.detail && (
                <span
                  className={`zkm-step-tracker__detail zkm-step-tracker__detail--${detailTone(
                    step,
                  )}`}
                >
                  {step.detail}
                </span>
              )}
            </span>
          </li>
        ))}
      </ol>
    </div>
  )
}

export interface NextStepsProps {
  /** e.g. "What happens next?". */
  title: string
  steps: { label: string; detail?: string }[]
}

/** Numbered preview of a flow's steps. */
export function NextSteps({ title, steps }: NextStepsProps) {
  return (
    <section className="zkm-sheet-card zkm-next-steps">
      <h3 className="zkm-next-steps__title">{title}</h3>
      <ol className="zkm-next-steps__list">
        {steps.map((step, i) => (
          <li key={i} className="zkm-next-steps__item">
            <span className="zkm-next-steps__number">{i + 1}</span>
            <span className="zkm-next-steps__text">
              <span className="zkm-next-steps__label">{step.label}</span>
              {step.detail && <span className="zkm-next-steps__detail">{step.detail}</span>}
            </span>
          </li>
        ))}
      </ol>
    </section>
  )
}
