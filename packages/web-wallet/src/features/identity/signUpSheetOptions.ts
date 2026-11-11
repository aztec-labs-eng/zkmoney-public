import {
  type LaptopCreation,
  type PhoneReach,
  type SheetReopen,
  type SignUpChoice,
  type SignUpOptions,
  currentUserAgentInfoSync,
  ignoresHintsFor,
  keptPasskeyApiFor,
  passkeyExtensionFor,
  signUpOptionsFor,
} from "@obsidion/passkey-web"
import type { IconName } from "@obsidion/web-ds"
import { backupPasskeySettingsEnabled } from "../../config/features"
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
  /** The device's `localRefusals`. */
  refusals: number
}): SignUpOptions {
  const extension = passkeyExtensionFor()
  const ua = currentUserAgentInfoSync()
  const { refusals, ...probed } = input
  return signUpOptionsFor({
    ...probed,
    extension,
    protonKept: keptPasskeyApiFor("create") !== undefined,
    refusedOften: localRefusalsOverLimit(extension !== "none", refusals),
    ignoresHints: ignoresHintsFor(ua),
    os: ua.osFamily,
    backupAddable: backupPasskeySettingsEnabled,
  })
}

export const SIGN_UP_ICONS: Readonly<Record<SignUpChoice, IconName>> = {
  "computer": "fingerprint",
  "1password": "lock",
  "proton": "lock",
  "phone": "qr-code",
  "phone-or-key": "qr-code",
  "key": "key",
}
