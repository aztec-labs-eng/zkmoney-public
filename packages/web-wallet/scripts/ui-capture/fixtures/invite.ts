import type { Invite } from "../../../src/features/invite/useInvite"

export * from "../../../src/features/invite/useInvite"

/** Captures have no account service to sign an invite lookup against. */
export const useInvite = (): Invite => ({ code: "DEMO42", credited: false })
