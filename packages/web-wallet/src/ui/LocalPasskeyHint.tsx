import { useEffect, useState } from "react"
import {
  type DevicePosture,
  type OsFamily,
  currentDevicePosture,
  currentUserAgentInfoSync,
  isPhysicalOnly,
  providerSlugFor,
} from "@obsidion/passkey-web"
import { provingProgress } from "@obsidion/proving-progress"
import { type AnswerRecord, answerRecordFor } from "../platform/auth/WebPasskeyIdentityMap"
import { getActiveCredentialId } from "../platform/storage/activeStorage"
import { deviceStorage } from "../platform/storage/rollupStorage"

const SHOWN_KEY = "webwallet.local-passkey-hint-shown"
/** Signature attempts the line accompanies before it stops by itself. */
const MAX_SHOWN = 3

const shownCount = () => Number(deviceStorage.getItem(SHOWN_KEY)) || 0

/** Counts one more attempt; false once they are spent. A store that fails costs a showing, not the beat. */
function countAttempt(): boolean {
  try {
    const shown = shownCount()
    if (shown >= MAX_SHOWN) return false
    deviceStorage.setItem(SHOWN_KEY, String(shown + 1))
  } catch {
    // Best-effort.
  }
  return true
}

type Readers = {
  posture: () => DevicePosture
  shown: () => number
  /** The session passkey's record. */
  record: () => AnswerRecord | undefined
  osFamily: () => OsFamily
}

const LIVE: Readers = {
  posture: currentDevicePosture,
  shown: shownCount,
  record: () => {
    const credentialId = getActiveCredentialId()
    return credentialId ? answerRecordFor(credentialId) : undefined
  },
  osFamily: () => currentUserAgentInfoSync().osFamily,
}

/**
 * Whether to tell a laptop user that this computer's copy of the passkey may answer. `remote` says
 * another device last answered with a passkey that can be backed up, which is a reason to suggest
 * the copy, not proof one exists: a known hardware key and an iCloud Keychain passkey off a Mac are
 * left out, since neither can have one here.
 */
export function localPasskeyHintApplies(read: Readers = LIVE): boolean {
  if (read.posture() !== "laptop" || read.shown() >= MAX_SHOWN) return false
  const record = read.record()
  if (record?.answered !== "remote") return false
  if (record.inferredTransports || (record.transports && isPhysicalOnly(record.transports))) {
    return false
  }
  return !(providerSlugFor(record.prfAaguid) === "icloud_keychain" && read.osFamily() !== "macos")
}

export const localPasskeyHintCopy = (osFamily: OsFamily) =>
  `If your passkey has synced to this computer, choose ${
    osFamily === "macos" ? "Touch ID" : "the passkey saved on this computer"
  } or your password manager in the passkey prompt instead of the QR code.`

/**
 * The line a working beat shows before and during the passkey prompt. Each signature attempt it
 * sits beside is one showing; it stays through the last one.
 */
export function LocalPasskeyHint() {
  const [show, setShow] = useState(() => {
    try {
      return localPasskeyHintApplies()
    } catch {
      return false
    }
  })
  useEffect(() => {
    if (!show) return
    const onAttempt = () => {
      if (!countAttempt()) setShow(false)
    }
    provingProgress.on("signing-start", onAttempt)
    return () => {
      provingProgress.off("signing-start", onAttempt)
    }
  }, [show])

  if (!show) return null
  return (
    <span className="ww-pay__hint">
      {localPasskeyHintCopy(currentUserAgentInfoSync().osFamily)}{" "}
      <button
        type="button"
        className="zkm-btn-reset ww-pay__hint-dismiss"
        onClick={() => {
          try {
            deviceStorage.setItem(SHOWN_KEY, String(MAX_SHOWN))
          } catch {
            // Hidden for this mount either way.
          }
          setShow(false)
        }}
      >
        Don't show again
      </button>
    </span>
  )
}
