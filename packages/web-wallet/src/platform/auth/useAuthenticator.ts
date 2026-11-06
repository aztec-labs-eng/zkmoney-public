import {
  bestEffort,
  compAddrToAztecAddrStr,
  valueOf,
  type AccountRecord,
  type Database,
  type Resource,
  type WebAuthnData,
  WalletError,
} from "@obsidion/front-core"
import { Network } from "@obsidion/core/constants"
import {
  BrowserPasskeyCeremony,
  CHROMIUM_VIRTUAL_AUTHENTICATOR_AAGUID,
  DEFAULT_CEREMONY_TIMING,
  type PasskeyCeremony,
} from "@obsidion/passkey-web"
import { AUTH_TYPE, type ObsidionWallet } from "@obsidion/sdk"
import { backupPasskeySettingsEnabled } from "../../config/features"
import { passkeyTelemetry } from "../../lib/passkeyTelemetry"
import { writeDeviceKeys } from "../storage/deviceKeys"
import {
  WebAlphaAuthService,
  type StoredAccountSnapshot,
  type WebAlphaAuthServiceOptions,
} from "./WebAlphaAuthService"

/**
 * The e2e build writes each create request's device ask, hints and timeout into the wallet
 * database, where the specs read them: the browser's credential list only proves a credential
 * exists, not what the wallet asked for.
 */
function recordingCreateRequests(ceremony: PasskeyCeremony, db: Database): PasskeyCeremony {
  return {
    create: (request) => {
      // A record the specs can't read fails there, not here.
      void bestEffort(
        "unknown",
        writeDeviceKeys(db, {
          lastCreateRequest: JSON.stringify({
            authenticatorAttachment: request.authenticatorAttachment,
            hints: request.hints,
            timeoutMs: request.timeoutMs,
          }),
        }),
      )
      return ceremony.create(request)
    },
    assert: (request) => ceremony.assert(request),
  }
}

/**
 * The page's auth service over its database, device keys and session lock: `onSessionSaved`
 * follows each saved session change.
 */
export function createAuthService(
  config: { network: Network; rpId: string; rpName: string },
  page: Pick<WebAlphaAuthServiceOptions, "database" | "device" | "sessionLock">,
  onSessionSaved: () => Promise<void>,
): WebAlphaAuthService {
  // The e2e build drives Chromium's virtual authenticators: the hybrid hint can steer the sheet
  // away from them, and they report a fixed provider id the allowlist would otherwise refuse.
  // Nothing else sets this flag, so production sends the hint and admits no extra id. Admitting
  // an id widens a gate on the key a funded wallet derives, so mainnet refuses the flag outright,
  // as it does for the other build flags that relax a check.
  const virtualAuthenticators = import.meta.env.VITE_E2E_VIRTUAL_AUTHENTICATORS === "true"
  if (virtualAuthenticators && config.network === Network.MAINNET) {
    throw new WalletError(
      "config.invalid",
      "VITE_E2E_VIRTUAL_AUTHENTICATORS widens the passkey provider allowlist — not valid on mainnet",
    )
  }
  const ceremony = passkeyTelemetry.wrap(
    new BrowserPasskeyCeremony(DEFAULT_CEREMONY_TIMING, passkeyTelemetry.requestHook),
  )
  return new WebAlphaAuthService({
    ...page,
    rpId: config.rpId,
    rpName: config.rpName,
    ceremony: virtualAuthenticators ? recordingCreateRequests(ceremony, page.database) : ceremony,
    laptopHints: virtualAuthenticators ? null : undefined,
    extraProviders: virtualAuthenticators ? [CHROMIUM_VIRTUAL_AUTHENTICATOR_AAGUID] : undefined,
    // Windows Hello keeps the only copy, so it is offered only where a backup can be added.
    withdrawnManagers: backupPasskeySettingsEnabled ? undefined : ["windows_hello"],
    onSessionSaved,
  })
}

/** The signed-in session's account record, or none for a visitor. */
export type AccountsOf = () => Pick<AccountRecord, "get" | "save"> | null

/** The stored account as a cache restore compares it. */
async function readStoredAccount(accounts: AccountsOf): Promise<StoredAccountSnapshot | null> {
  const account = await accounts()?.get()
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

/** Names `signer` as the stored account's signer, at the address it already holds. */
export async function writeStoredSigner(accounts: AccountsOf, signer: WebAuthnData): Promise<void> {
  const record = accounts()
  const account = await record?.get()
  if (account?.signKeyConfig.type !== AUTH_TYPE.WEB_AUTHN) return
  await record?.save({
    ...account,
    signKeyConfig: { ...account.signKeyConfig, webauthnData: signer },
  })
}

/**
 * The auth service over `wallet`: its address derivation and the stored account, so a cached key
 * can be proved before the account's unlock asks for it.
 */
export function walletAuth(
  service: WebAlphaAuthService,
  wallet: ObsidionWallet,
  accounts: AccountsOf,
): WebAlphaAuthService {
  service.setAddressDeriver(async (msk, passkeys) =>
    (await wallet.deriveAccountAddress(msk, passkeys)).toString(),
  )
  service.setAccountReader(() => readStoredAccount(accounts))
  service.setSignerWriter((signer) => writeStoredSigner(accounts, signer))
  return service
}

/** Hands the page's wallet to the auth service once it is up, whichever session the page runs. */
export function bindWalletAuth(
  service: WebAlphaAuthService,
  wallet: Resource<ObsidionWallet>,
  accounts: AccountsOf,
): void {
  const bind = () => {
    const ready = valueOf(wallet)
    if (!ready) return
    off()
    walletAuth(service, ready, accounts)
  }
  const off = wallet.subscribe(bind)
  bind()
}
