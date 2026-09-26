import {
  AccountStorage,
  compAddrToAztecAddrStr,
  useAztecContext,
  type UseAuthenticator,
} from "@obsidion/front-core"
import { Network } from "@obsidion/core/constants"
import {
  BrowserPasskeyCeremony,
  CHROMIUM_VIRTUAL_AUTHENTICATOR_AAGUID,
  DEFAULT_CEREMONY_TIMING,
} from "@obsidion/passkey-web"
import { AUTH_TYPE } from "@obsidion/sdk"
import { getConfig } from "../../config/env"
import { passkeyTelemetry } from "../../lib/passkeyTelemetry"
import { webStorage } from "../storage/WebStorageAdapter"
import { WebAlphaAuthService, type StoredAccountSnapshot } from "./WebAlphaAuthService"

let singleton: WebAlphaAuthService | undefined

/** Process-wide auth-service singleton. */
export function getAuthService(): WebAlphaAuthService {
  if (!singleton) {
    const config = getConfig()
    // The e2e build drives Chromium's virtual authenticators: the hybrid hint can steer the sheet
    // away from them, and they report a fixed provider id the allowlist would otherwise refuse.
    // Nothing else sets this flag, so production sends the hint and admits no extra id. Admitting
    // an id widens a gate on the key a funded wallet derives, so mainnet refuses the flag outright,
    // as it does for the other build flags that relax a check.
    const virtualAuthenticators = import.meta.env.VITE_E2E_VIRTUAL_AUTHENTICATORS === "true"
    if (virtualAuthenticators && config.network === Network.MAINNET) {
      throw new Error(
        "VITE_E2E_VIRTUAL_AUTHENTICATORS widens the passkey provider allowlist — not valid on mainnet",
      )
    }
    singleton = new WebAlphaAuthService({
      storage: webStorage,
      rpId: config.rpId,
      rpName: config.rpName,
      ceremony: passkeyTelemetry.wrap(
        new BrowserPasskeyCeremony(DEFAULT_CEREMONY_TIMING, passkeyTelemetry.requestHook),
      ),
      laptopHints: virtualAuthenticators ? null : undefined,
      extraProviders: virtualAuthenticators ? [CHROMIUM_VIRTUAL_AUTHENTICATOR_AAGUID] : undefined,
    })
  }
  return singleton
}

/** The singleton if one was built; a sign-out before any boot has nothing to clear. */
export function peekAuthService(): WebAlphaAuthService | undefined {
  return singleton
}

/** The stored account as a cache restore compares it. */
async function readStoredAccount(): Promise<StoredAccountSnapshot | null> {
  const account = await AccountStorage.get().getAccount()
  if (!account) return null
  const passkey =
    account.signKeyConfig.type === AUTH_TYPE.WEB_AUTHN ? account.signKeyConfig.webauthnData : null
  if (!passkey) return { kind: "other" }
  return {
    kind: "webauthn",
    credentialId: passkey.credentialId,
    pubkey: passkey.pubkey,
    address: await compAddrToAztecAddrStr(account.completeAddress),
  }
}

/**
 * `UseAuthenticator` for front-core's `AccountProvider`/`useAccount`. Web has
 * no biometric unlock modal — a locked MSK surfaces through `useAccount`'s
 * `unlockError`/`retryUnlock` flow instead (recover → verify → commit). The
 * wallet's address derivation and the stored account are handed to the service
 * in the same render front-core's account effect depends on, so a cached key
 * can be proved before that effect asks for it.
 */
export const useAuthenticator: UseAuthenticator = () => {
  const { obsidionWallet } = useAztecContext()
  const service = getAuthService()
  if (obsidionWallet) {
    service.setAddressDeriver(async (msk, pubkeyHex) =>
      (await obsidionWallet.deriveAccountAddress(msk, pubkeyHex)).toString(),
    )
    service.setAccountReader(readStoredAccount)
  }
  return { showUnlockModal: false, authService: service }
}
