import type { SignInRoute } from "@obsidion/core/types"
import {
  AUTH_TYPE,
  TESTNET_TIMEOUT,
  type ObsidionAccount,
  type ObsidionWallet,
  type AlphaAuthService,
} from "@obsidion/sdk"
import type { AccountRecord } from "../engine/account"
import { WalletError } from "../engine/errors"
import { logger } from "../utils/logger"

/**
 * Creates the passkey and its account, then commits the master key and stores the account. The caller hands the returned account to the session.
 */
export async function createAccount(
  {
    wallet: obsidionWallet,
    authService,
    accounts,
  }: {
    wallet: ObsidionWallet
    authService: AlphaAuthService
    /** The signed-in session's account record, read once the secret is committed. */
    accounts: () => Pick<AccountRecord, "save">
  },
  _authType: AUTH_TYPE,
  updateStatus: (status: string) => void,
  accountName?: string,
  opts?: {
    /** A testnet or mainnet node: the account deploy waits the longer production timeout. */
    prod?: boolean
    /** CREATE dispatch: "combined" presents both (iOS 26.4+), the forced variants
     * back the fallback button. Default platform. */
    mode?: "combined" | "platform" | "security-key"
    /** The device the user picked on the laptop steps, so the browser opens on it. */
    route?: SignInRoute
    /** Ends the passkey prompt when the caller abandons the attempt. */
    signal?: AbortSignal
    /** Post-detect/pre-deploy hook: when a fresh CREATE resolves to a security
     * key, await acknowledgement of the no-backup warning before any on-chain
     * deploy. Returning false aborts (only an orphan passkey remains). */
    onSecurityKeyDetected?: () => Promise<boolean>
    /** Persist caller-owned recovery state before the new session is committed. */
    onAccountCreated?: (account: {
      credentialId: string
      l2Address: string
    }) => Promise<void> | void
  },
): Promise<ObsidionAccount> {
  updateStatus("Creating passkey...")

  logger.log("createAccount...")
  if (!accountName) accountName = "Account 1"

  let obsidionAccount: ObsidionAccount
  try {
    // The MSK comes out of credential creation, never in: it derives from
    // the passkey's PRF output (regenerable at login from the credential
    // itself).
    const {
      authProvider,
      credentialId,
      pubkey,
      secretKey,
      prfSlot,
      prfAaguid,
      authenticatorType,
      transports,
    } = await authService.createPasskey(accountName, updateStatus, {
      mode: opts?.mode,
      route: opts?.route,
      signal: opts?.signal,
    })

    // No-backup acknowledgement gate: a security-key wallet has no iCloud
    // backup. Fire AFTER the class is detected and BEFORE the on-chain deploy,
    // so a decline leaves only an orphan passkey — no on-chain account, no
    // recovery record, no committed MSK. (Below 26.4 a security key is never
    // offered, so this never triggers there; a caller with no callback proceeds.)
    if (authenticatorType === "security-key") {
      const acknowledged = (await opts?.onSecurityKeyDetected?.()) ?? true
      if (!acknowledged) throw new WalletError("account.creationCancelled")
    }

    obsidionAccount = await obsidionWallet.createObsidionAccount(secretKey, authProvider, {
      timeout: opts?.prod ? TESTNET_TIMEOUT : undefined,
      updateStatus,
    })

    const l2Address = obsidionAccount.getAddress().toString()
    logger.log("Account created at:", l2Address)

    // REQUIRED before committing the MSK: persist the recovery record so a
    // fresh-device recover has an address to verify against. A failure
    // aborts onboarding (retryable) — never an account without a record.
    updateStatus("Securing recovery info...")
    await authService.recordRecoveryMetadata({
      credentialId,
      pubkey,
      l2Address,
      prfSlot,
      prfAaguid,
      isMskRoot: true,
      authenticatorType,
      transports,
    })
    await opts?.onAccountCreated?.({ credentialId, l2Address })
    updateStatus("Securing your master key...")
    await authService.commitSecret({ secretKey, authProvider })

    await storeAccount(accounts(), obsidionAccount, credentialId, pubkey, authenticatorType)
    return obsidionAccount
  } catch (error) {
    logger.error("Failed to create obsidion account:", error)
    throw error
  }
}

async function storeAccount(
  accounts: Pick<AccountRecord, "save">,
  obsidionAccount: ObsidionAccount,
  credentialId: string,
  pubkey: string,
  authenticatorType?: "platform" | "security-key",
) {
  await accounts.save({
    completeAddress: obsidionAccount.getCompleteAddress().toString(),
    signKeyConfig: {
      type: AUTH_TYPE.WEB_AUTHN,
      webauthnData: { credentialId, pubkey, ...(authenticatorType ? { authenticatorType } : {}) },
    },
  })
}
