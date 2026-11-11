import { useEffect, useState } from "react"
import {
  type DevicePosture,
  type OsFamily,
  currentDevicePosture,
  currentUserAgentInfoSync,
  isPhysicalOnly,
  providerSlugFor,
} from "@obsidion/passkey-web"
import { type AnswerRecord, answerRecordFor } from "../platform/auth/WebPasskeyIdentityMap"
import { bestEffort } from "@obsidion/core/errors"
import { countHintShowing, savePrefs, type DeviceState } from "../platform/storage/deviceKeys"
import { useSession } from "../session/session"

/** Signature attempts the line accompanies before it stops by itself. */
const MAX_SHOWN = 3

type Readers = {
  posture: () => DevicePosture
  shown: () => number
  /** The session passkey's record. */
  record: () => AnswerRecord | undefined
  osFamily: () => OsFamily
}

/** The readers over the page's saved device keys. */
export const liveHintReaders = ({
  credentialId,
  passkeyMap,
  localPasskeyHintShown,
}: DeviceState): Readers => ({
  posture: currentDevicePosture,
  shown: () => localPasskeyHintShown,
  record: () => (credentialId ? answerRecordFor(passkeyMap, credentialId) : undefined),
  osFamily: () => currentUserAgentInfoSync().osFamily,
})

/**
 * Whether to tell a laptop user that this computer's copy of the passkey may answer. `remote` says
 * another device last answered with a passkey that can be backed up, which is a reason to suggest
 * the copy, not proof one exists: a known hardware key and an iCloud Keychain passkey off a Mac are
 * left out, since neither can have one here.
 */
export function localPasskeyHintApplies(read: Readers): boolean {
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
  const { database, device, page } = useSession()
  const [show, setShow] = useState(() => {
    try {
      return localPasskeyHintApplies(liveHintReaders(device.get()))
    } catch {
      return false
    }
  })
  // eslint-disable-next-line local/effect-hook -- debt
  useEffect(() => {
    if (!show) return
    // Each attempt counts one showing; once they are spent the line goes.
    const { progress } = page.prover
    let started = progress.get().signing.started
    return progress.subscribe(() => {
      if (progress.get().signing.started === started) return
      started = progress.get().signing.started
      void bestEffort("unknown", countHintShowing(database, MAX_SHOWN)).then((shown) => {
        if (shown !== undefined && shown >= MAX_SHOWN) setShow(false)
      })
    })
  }, [show, database, page])

  if (!show) return null
  return (
    <span className="ww-pay__hint">
      {localPasskeyHintCopy(currentUserAgentInfoSync().osFamily)}{" "}
      <button
        type="button"
        className="zkm-btn-reset ww-pay__hint-dismiss"
        onClick={() => {
          savePrefs(database, { localPasskeyHintShown: String(MAX_SHOWN) })
          setShow(false)
        }}
      >
        Don't show again
      </button>
    </span>
  )
}
