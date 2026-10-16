export type ActivationStepId = "passkey" | "deposit"

export interface ActivationStep {
  id: ActivationStepId
  done: boolean
  /** Running on its own; nothing for the user to do. */
  busy?: boolean
}

const ORDER: ActivationStepId[] = ["passkey", "deposit"]
export const ACTIVATION_STEP_COUNT = ORDER.length
export const activationStepNumber = (id: ActivationStepId) => ORDER.indexOf(id) + 1

/**
 * The activation steps Home lists. The tag is settled in the card's header before the passkey, which
 * is named after it.
 */
export function activationSteps({
  account,
  deposited,
  ticket = false,
}: {
  /** The passkey exists. */
  account: boolean
  deposited: boolean
  /** Funded by a golden ticket: the link's claim pays the deposit. */
  ticket?: boolean
}): ActivationStep[] {
  return [
    { id: "passkey", done: account },
    { id: "deposit", done: false, busy: ticket || deposited },
  ]
}
