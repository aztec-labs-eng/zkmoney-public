import { Icon, type IconName } from "@obsidion/web-ds"

const STEPS: readonly { label: string; icon: IconName }[] = [
  { label: "Choose tag", icon: "at" },
  { label: "Create account", icon: "key" },
  { label: "Claim payment", icon: "coins" },
]

/** The three steps of a paylink-funded signup (Figma 11118:53747): done, active, to do. */
export function SignupStepper({ current }: { current: 0 | 1 | 2 }) {
  return (
    <ol className="ww-signup-stepper" aria-label="Signup progress">
      {STEPS.map((step, i) => {
        const state = i < current ? "done" : i === current ? "active" : "todo"
        return (
          <li
            key={step.label}
            className={`ww-signup-stepper__step ww-signup-stepper__step--${state}`}
            aria-current={state === "active" ? "step" : undefined}
          >
            <span className="ww-signup-stepper__dot">
              <Icon
                name={state === "done" ? "check" : step.icon}
                size={18}
                color={state === "todo" ? "var(--text-secondary)" : "var(--accent-green)"}
              />
            </span>
            <span className="ww-signup-stepper__label">{step.label}</span>
          </li>
        )
      })}
    </ol>
  )
}
