import {
  type LaptopCreation,
  type PhoneReach,
  type SheetReopen,
  type SignUpChoice,
  type SignUpOptions,
  currentUserAgentInfoSync,
  ignoresHintsFor,
  passkeyExtensionFor,
  signUpOptionsFor,
} from "@obsidion/passkey-web"
import type { IconName } from "@obsidion/web-ds"
import { localRefusalsOverLimit } from "../../platform/auth/localRefusals"

/**
 * The laptop sign-up sheet's options for what the probes said, with this page's own reads taken
 * now. The sheet and the gate's check of an earlier pick both ask here, so they never disagree.
 */
export function signUpSheetOptions(input: {
  creation: LaptopCreation
  reach: PhoneReach
  preferred?: SignUpChoice
  reopened?: SheetReopen
}): SignUpOptions {
  const extension = passkeyExtensionFor()
  const ua = currentUserAgentInfoSync()
  return signUpOptionsFor({
    ...input,
    extension,
    refusedOften: localRefusalsOverLimit(extension !== "none"),
    ignoresHints: ignoresHintsFor(ua),
    os: ua.osFamily,
  })
}

export const SIGN_UP_ICONS: Readonly<Record<SignUpChoice, IconName>> = {
  "computer": "fingerprint",
  "1password": "lock",
  "phone": "qr-code",
  "phone-or-key": "qr-code",
  "key": "key",
}
