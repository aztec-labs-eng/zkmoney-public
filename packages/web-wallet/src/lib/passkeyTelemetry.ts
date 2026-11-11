import {
  type PasskeyClassification,
  type PasskeyEnvironment,
  type PasskeyFlow,
  createPasskeyTelemetry,
  providerSlugFor,
} from "@obsidion/passkey-web"
import { WalletError } from "@obsidion/core/errors"
import { fireEvent } from "./analytics"

const PASSKEY_MISMATCH: PasskeyClassification = { outcome: "refused", reason: "passkey_mismatch" }
const SESSION_LOST: PasskeyClassification = { outcome: "failed", reason: "session_lost" }

/** The page's last passkey environment, from its device keys once the page binds them. */
// eslint-disable-next-line no-restricted-syntax -- ZKM-1778
let lastEnvironment = (): PasskeyEnvironment | null => null

export function bindPasskeyEnvironment(read: () => PasskeyEnvironment | null): void {
  lastEnvironment = read
}

const walletTracker = () =>
  createPasskeyTelemetry({
    send: (props) => fireEvent("passkey_ceremony", props),
    extraNames: {
      PasskeyMismatchError: PASSKEY_MISMATCH,
      HintedKeyMismatchError: PASSKEY_MISMATCH,
      StoredAddressMismatchError: PASSKEY_MISMATCH,
      PasskeyEnvelopeError: { outcome: "failed", reason: "backup_envelope" },
      SignerKeyMismatchError: { outcome: "failed", reason: "signer_mismatch" },
      NoPasskeySessionError: SESSION_LOST,
      SessionChangedError: SESSION_LOST,
      GateCancelledError: { outcome: "cancelled", reason: "in_app_cancel" },
    },
    extraPredicates: [
      {
        test: (error) => error instanceof WalletError && error.code === "passkey.unasked",
        classification: PASSKEY_MISMATCH,
      },
    ],
    fallbackProvider: () => providerSlugFor(lastEnvironment()?.aaguid),
  })

/**
 * The wallet's one passkey tracker. Its events go out through `fireEvent`, which sends a result the
 * signup flow opened identifier-free and holds every other one behind the analytics answer.
 * A mismatched passkey reads the same on every path.
 */
export const passkeyTelemetry = walletTracker()

const SIGNING_FLOWS: readonly PasskeyFlow[] = [
  "send",
  "paylink-create",
  "paylink-claim-l1",
  "withdraw",
  // A signup funded by a payment link signs one batch to spend it, with the passkey just made.
  "onboarding",
]

/** The proving screens holding an attempt, newest last. */
const signingFlows: { flow: PasskeyFlow }[] = []

/** Names the flow a signature belongs to until the returned release is called. */
export function holdSigningFlow(flow: string): () => void {
  const hold: { flow: PasskeyFlow } = {
    flow: SIGNING_FLOWS.find((known) => known === flow) ?? "other",
  }
  signingFlows.push(hold)
  return () => {
    const index = signingFlows.indexOf(hold)
    if (index >= 0) signingFlows.splice(index, 1)
  }
}

/** The flow of the newest screen still holding one, else `other`. */
export const activeSigningFlow = (): PasskeyFlow => signingFlows.at(-1)?.flow ?? "other"
