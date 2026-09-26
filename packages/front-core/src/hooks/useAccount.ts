import { useEffect, useState } from "react"
import type { SignInRoute } from "@obsidion/core/types"
import {
  AccountStorage,
  NetworkStorage,
  selectRecoveredMsk,
  canonicalGenerationStack,
} from "src/core"
import {
  TESTNET_TIMEOUT,
  ObsidionAccount,
  ObsidionWallet,
  AUTH_TYPE,
  AlphaAuthService,
  AlphaAuthProvider,
} from "@obsidion/sdk"
import { useAztecContext } from "src/contexts"
import { completeAddressWireFormat, isDefined } from "src/utils"
import { assert } from "ts-essentials"
import { CompleteAddress } from "@aztec/stdlib/contract"
import { Fr } from "@aztec/foundation/curves/bn254"
import { logger } from "src/utils/logger"

export type UseAuthenticator = () => {
  showUnlockModal: boolean
  authService: AlphaAuthService | undefined
}

export const useAccount = (useAuthenticator: UseAuthenticator) => {
  const [accountExists, setAccountExists] = useState<boolean | undefined>(undefined)
  const [obsidionAccount, setObsidionAccount] = useState<ObsidionAccount | undefined>()
  const [callingGetAccountContract, setCallingGetAccountContract] = useState<boolean>(false)
  /**
   * Non-empty when the most recent unlock attempt failed (Face ID
   * cancelled, biometric mismatch, or any auth-service error). Consumers
   * (e.g. the boot loading screen) can render this and call
   * `retryUnlock()` to invoke another Face ID prompt without forcing a
   * full app restart.
   */
  const [unlockError, setUnlockError] = useState<string | undefined>(undefined)

  const { obsidionWallet } = useAztecContext()
  const { showUnlockModal, authService } = useAuthenticator()

  useEffect(() => {
    const _getAccountContract = async () => {
      const accountExists = await AccountStorage.get().hasAccount()
      setAccountExists(accountExists)

      if (
        obsidionWallet &&
        authService &&
        obsidionAccount === undefined &&
        accountExists &&
        !showUnlockModal
      ) {
        const recoveredObsidionAccount = await getAccountContract()
        if (!isDefined(recoveredObsidionAccount, "obsidionAccount")) return
        setObsidionAccount(recoveredObsidionAccount)
      }
    }

    _getAccountContract()
  }, [obsidionWallet, obsidionAccount, showUnlockModal, authService])

  const getAccountContract = async (service?: AlphaAuthService) => {
    setCallingGetAccountContract(true)

    if (callingGetAccountContract) {
      logger.log("callingGetAccountContract is true, returning")
      return
    }

    // Clear any previous unlock error — if this attempt fails the catch
    // block below sets a fresh message; if it succeeds the state stays
    // cleared.
    setUnlockError(undefined)

    logger.log("getAccountContract...")
    const currentAccount = await AccountStorage.get().getAccount()

    service = service || authService

    if (
      !isDefined(currentAccount, "currentAccount") ||
      !isDefined(obsidionWallet, "obsidionWallet") ||
      !isDefined(service, "authService")
    ) {
      return
    }

    try {
      const authProvider = await service.getAuthProvider()
      if (!isDefined(authProvider, "authProvider not found")) return

      const secretKey = await service.getSecretKey()
      if (!isDefined(secretKey, "secretKey")) {
        // An auth service may return `undefined` (not throw) when the
        // authenticator is cancelled or fails — surface a retryable error so the UI can
        // prompt the user to try again instead of getting stuck.
        setUnlockError("Authentication failed. Tap retry to unlock your account.")
        return
      }

      // front-core's `CompleteAddress` is the v5 parser — the 288-byte
      // layout. A v4 (320-byte) address parsed here silently misaligns the
      // publicKeys (→ off-curve `ivpkM`, a cryptic downstream crash). Gated on
      // canonical stack: only the v5 stack parses 288B blobs and persists a
      // rewrite; v4-canonical still skips a v5 misparse / re-derives via
      // the live wallet but leaves AccountStorage alone.
      const stack = canonicalGenerationStack()
      let storedCompleteAddress: CompleteAddress | undefined = undefined
      const storedFormat = currentAccount.completeAddress
        ? completeAddressWireFormat(currentAccount.completeAddress)
        : "unknown"
      if (stack === "v5" && currentAccount.completeAddress && storedFormat === "v5") {
        storedCompleteAddress = await CompleteAddress.fromString(currentAccount.completeAddress)
      } else if (currentAccount.completeAddress) {
        // Do not pass the blob through the v5 parser (wrong size or v4-canonical).
        if (stack === "v5") {
          const byteLength = currentAccount.completeAddress.replace(/^0x/i, "").length / 2
          console.log(
            `[Account restore] stored completeAddress is ${storedFormat} (${byteLength}B) on canonical v5 — ` +
              `re-deriving via the generation wallet instead of mis-parsing`,
          )
        }
      }

      const obsidionAccount = await obsidionWallet.getObsidionAccountWallet(
        secretKey,
        authProvider,
        {
          completeAddress: storedCompleteAddress,
          register: true,
        },
      )
      logger.log(
        "obsidionAccount in getAccountContract: ",
        obsidionAccount?.getAddress().toString(),
      )

      if (stack === "v5" && obsidionAccount && storedFormat !== "v5") {
        const derived = obsidionAccount.getCompleteAddress().toString()
        if (derived !== currentAccount.completeAddress) {
          await AccountStorage.get().setAccount({
            ...currentAccount,
            completeAddress: derived,
          })
          console.log(
            `[Account restore] rewrote stored completeAddress to v5 wire form (${completeAddressWireFormat(
              derived,
            )})`,
          )
        }
      }

      return obsidionAccount
    } catch (error) {
      logger.error("Failed to get obsidion account: ", error)
      setUnlockError(error instanceof Error ? error.message : "Failed to unlock account.")
      return
    } finally {
      setCallingGetAccountContract(false)
    }
  }

  /**
   * Re-attempt unlocking the account after a failed Face ID / biometric
   * prompt. Calls `getAccountContract` (which triggers a fresh
   * `getSecretKey` → Face ID prompt) and installs the recovered account
   * on success. The auth service is a process singleton with no cached
   * MSK after failure, so calling `getSecretKey` again surfaces a new
   * biometric prompt.
   */
  const retryUnlock = async (): Promise<void> => {
    const recoveredObsidionAccount = await getAccountContract()
    if (isDefined(recoveredObsidionAccount, "obsidionAccount")) {
      setObsidionAccount(recoveredObsidionAccount)
    }
  }

  const createAccount = async (
    isImport: boolean,
    _authType: AUTH_TYPE,
    updateStatus: (status: string) => void,
    accountName?: string,
    credentialId?: string,
    opts?: {
      /** CREATE dispatch: "combined" presents both (iOS 26.4+), the forced variants
       * back the fallback button. Default platform. */
      mode?: "combined" | "platform" | "security-key"
      /** The device the user picked on the laptop steps, so the browser opens on it. */
      route?: SignInRoute
      replaceCurrentWallet?: boolean
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
  ): Promise<ObsidionAccount> => {
    updateStatus(`${isImport ? "Recovering" : "Creating"} passkey...`)

    logger.log("createAccount...")
    if (!accountName) accountName = "Account 1"

    assert(obsidionWallet, "wallet not found")
    assert(authService, "authService not found")

    let obsidionAccount: ObsidionAccount
    if (isImport) {
      const recovered = await authService.recoverPasskey(credentialId)

      // R10 verify-before-commit: pick the candidate whose derived account
      // address matches the stored one (fail closed otherwise), then commit —
      // the ONLY Keychain reseed point. `deriveAccountAddress` is the pure,
      // side-effect-free derivation from the master key and the recovered
      // signing key, so it never registers a wrong account.
      updateStatus(`Verifying recovered key...`)
      const secretKey = await selectRecoveredMsk(recovered, async (msk) =>
        (await obsidionWallet.deriveAccountAddress(msk, recovered.pubkey)).toString(),
      )

      // No-anchor guard: a security-key recover with no expected address commits
      // "the wallet this key roots" and OVERWRITES the single MSK Keychain slot.
      // Only allow it when the device has no current wallet (or with an explicit
      // replace flag from the UI), so it can't silently switch the active wallet.
      if (recovered.authenticatorType === "security-key" && !recovered.expectedAddress) {
        const deviceHasWallet = await AccountStorage.get().hasAccount()
        if (deviceHasWallet && !opts?.replaceCurrentWallet) {
          throw new Error(
            "This device already has a wallet. Recovering a different security key here would " +
              "replace it — confirm 'replace this device's wallet' to proceed.",
          )
        }
      }

      await authService.commitSecret({ secretKey, authProvider: recovered.authProvider })

      updateStatus(`Creating imported account...`)

      obsidionAccount = await obsidionWallet.getObsidionAccountWallet(
        secretKey,
        recovered.authProvider,
        { register: true },
      )

      await storeAccount(
        obsidionAccount,
        accountName,
        recovered.credentialId,
        recovered.pubkey,
        recovered.authenticatorType,
      )
      setObsidionAccount(obsidionAccount)
      return obsidionAccount
    } else {
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
        })

        // No-backup acknowledgement gate: a security-key wallet has no iCloud
        // backup. Fire AFTER the class is detected and BEFORE the on-chain deploy,
        // so a decline leaves only an orphan passkey — no on-chain account, no
        // recovery record, no committed MSK. (Below 26.4 a security key is never
        // offered, so this never triggers there; a caller with no callback proceeds.)
        if (authenticatorType === "security-key") {
          const acknowledged = (await opts?.onSecurityKeyDetected?.()) ?? true
          if (!acknowledged) {
            const declined = new Error("Security-key wallet creation was cancelled")
            declined.name = "SecurityKeyWarningDeclined"
            throw declined
          }
        }

        obsidionAccount = await obsidionWallet.createObsidionAccount(secretKey, authProvider, {
          timeout: (await NetworkStorage.get().isProd()) ? TESTNET_TIMEOUT : undefined,
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

        await storeAccount(obsidionAccount, accountName, credentialId, pubkey, authenticatorType)
        setObsidionAccount(obsidionAccount)
        return obsidionAccount
      } catch (error) {
        logger.error("Failed to create obsidion account:", error)
        throw error
      }
    }
  }

  const storeAccount = async (
    obsidionAccount: ObsidionAccount,
    accountName: string,
    credentialId: string,
    pubkey: string,
    authenticatorType?: "platform" | "security-key",
  ) => {
    logger.log("addWebauthnAccount...")
    await AccountStorage.get().addWebauthnAccount(
      accountName,
      obsidionAccount.getCompleteAddress().toString(),
      { credentialId, pubkey, ...(authenticatorType ? { authenticatorType } : {}) },
    )
  }

  const getSecretKey = async (): Promise<Fr | undefined> => {
    return authService?.getSecretKey()
  }

  return {
    showUnlockModal,
    accountExists,
    obsidionAccount,
    setObsidionAccount,
    createAccount,
    getSecretKey,
    unlockError,
    retryUnlock,
  }
}
