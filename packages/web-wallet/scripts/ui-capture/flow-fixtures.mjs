import path from "node:path"

// These replacements exist only in the server started by pnpm ui:capture.
export function flowFixturePlugin(walletDir) {
  const fixtures = path.join(walletDir, "scripts/ui-capture/fixtures")
  const modules = new Map([
    ["dev/seedDemo.ts", "seed.ts"],
    ["dev/demoDeposit.ts", "demo-deposit.ts"],
    ["features/contacts/contactPay.ts", "contact-pay.ts"],
    ["features/paylink/sponsoredPaylink.ts", "paylinks.ts"],
    ["features/paylink/paylinkExit.ts", "paylink-exit.ts"],
    ["features/withdraw/withdrawGateway.ts", "withdraw.ts"],
    ["features/deposit/fundDeposit.ts", "deposits.ts"],
    ["features/deposit/sipaAddresses.ts", "deposit-addresses.ts"],
    ["features/broadcasts/slotExecutor.ts", "slot-executor.ts"],
    ["session/useL1Wallet.ts", "l1-wallet.ts"],
    ["features/deposit/l1DepositTokenBalance.ts", "deposit-balance.ts"],
    ["features/deposit/capacityStore.ts", "capacity.ts"],
    ["features/deposit/sipaProcessingObserver.ts", "deposit-processing.ts"],
    ["features/allowance/readAllowance.ts", "allowance.ts"],
    ["features/withdraw/withdrawQuote.tsx", "withdraw-quote.ts"],
    ["features/withdraw/useFasterWithdrawal.ts", "faster-withdrawal.ts"],
    ["features/withdraw/etherfiCheck.ts", "etherfi-check.ts"],
    ["features/requests/accountlessRequest.ts", "request-landing.ts"],
    ["lib/feedback.ts", "feedback.ts"],
    ["features/registration/webRegistration.ts", "registration.ts"],
    ["features/sipa/useDepositWatch.ts", "registration-deposit.ts"],
    ["features/onboarding/oxideOnboarding.ts", "registration-account.ts"],
    ["features/identity/passkeyAccount.ts", "passkey-account.ts"],
    ["features/registration/nameAvailability.ts", "name-availability.ts"],
    ["features/invite/useInvite.ts", "invite.ts"],
    ["features/backupPasskey/backupScreen.ts", "backup-screen.ts"],
    ["features/registration/oxideGenerations.ts", "oxide-generations.ts"],
    ["config/features.ts", "features.ts"],
  ].map(([source, fixture]) => [path.join(walletDir, "src", source), path.join(fixtures, fixture)]))
  const contextConsumers = new Set([
    "features/contacts/ContactPayScreen/ContactPayScreen.tsx",
    "features/onboarding/OnboardingScreen/OnboardingScreen.tsx",
    "features/receive/useReceiveCode.ts",
    "features/paylink/usePaylinkDeps.ts",
    "features/paylink/LinkViewScreen.tsx",
    "features/withdraw/WithdrawFlow/WithdrawFlow.tsx",
    "features/deposit/DepositScreen/DepositScreen.tsx",
    "features/deposit/DepositFromWalletModal/DepositFromWalletModal.tsx",
    "features/backupPasskey/BackupPasskeyHost/BackupPasskeyHost.tsx",
  ].map((file) => path.join(walletDir, "src", file)))
  return {
    name: "wallet-ui-flow-fixtures",
    enforce: "pre",
    async resolveId(source, importer) {
      if (!importer || source.includes("capture-original")) return null
      if (importer.startsWith(fixtures + path.sep)) {
        const resolved = await this.resolve(source, importer, { skipSelf: true })
        return resolved && modules.has(resolved.id) ? `${resolved.id}?capture-original` : null
      }
      const owner = importer.split("?")[0]
      if (source === "@obsidion/front-core" && contextConsumers.has(owner)) {
        return path.join(fixtures, "contexts.ts")
      }
      // The Passkeys sheet reads its keys through the backup fixture.
      if (source === "@obsidion/front-core" && owner === path.join(walletDir, "src/ui/PasskeysModal.tsx")) {
        return path.join(fixtures, "passkey-keys.ts")
      }
      // The registration funding panel reads a recorded SIPA's terms from the processing observer's source.
      if (source === "@obsidion/sdk" && owner === path.join(walletDir, "src/features/deposit/addressCapacity.ts")) {
        return path.join(fixtures, "sipa-terms.ts")
      }
      const resolved = await this.resolve(source, importer, { skipSelf: true })
      // The Passkeys sheet reads the backup fixture's saved attempt.
      if (owner === path.join(walletDir, "src/ui/PasskeysModal.tsx") && resolved?.id === path.join(walletDir, "src/features/backupPasskey/backupRotations.ts")) {
        return path.join(fixtures, "backup-rotations.ts")
      }
      // The Passkeys sheet waits for the session's services before its key read.
      if (owner === path.join(walletDir, "src/ui/PasskeysModal.tsx") && resolved?.id === path.join(walletDir, "src/session/session.ts")) {
        return path.join(fixtures, "passkey-session.ts")
      }
      // The pay page reads its rollup through the boot's identity check.
      if (owner === path.join(walletDir, "src/features/requests/RequestLandingScreen.tsx") && resolved?.id === path.join(walletDir, "src/ui/PxeBoot.tsx")) {
        return path.join(fixtures, "request-identity.ts")
      }
      return resolved ? modules.get(resolved.id.split("?")[0]) ?? null : null
    },
  }
}
