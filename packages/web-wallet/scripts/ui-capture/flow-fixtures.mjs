import path from "node:path"

// These replacements exist only in the server started by pnpm ui:capture.
export function flowFixturePlugin(walletDir) {
  const fixtures = path.join(walletDir, "scripts/ui-capture/fixtures")
  const modules = new Map([
    ["dev/seedDemo.ts", "seed.ts"],
    ["features/contacts/contactPay.ts", "contact-pay.ts"],
    ["features/paylink/sponsoredPaylink.ts", "paylinks.ts"],
    ["features/paylink/paylinkExit.ts", "paylink-exit.ts"],
    ["features/withdraw/withdrawGateway.ts", "withdraw.ts"],
    ["features/deposit/sipaGateway.ts", "deposits.ts"],
    ["features/deposit/l1Wallet.ts", "l1-wallet.ts"],
    ["features/deposit/l1DepositTokenBalance.ts", "deposit-balance.ts"],
    ["features/withdraw/withdrawQuote.tsx", "withdraw-quote.ts"],
    ["features/requests/accountlessRequest.ts", "request-landing.ts"],
    ["lib/feedback.ts", "feedback.ts"],
    ["features/onboarding/webRegistration.ts", "registration.ts"],
    ["features/onboarding/useDepositWatch.ts", "registration-deposit.ts"],
    ["features/onboarding/oxideOnboarding.ts", "registration-account.ts"],
  ].map(([source, fixture]) => [path.join(walletDir, "src", source), path.join(fixtures, fixture)]))
  const contextConsumers = new Set([
    "features/contacts/ContactPayScreen.tsx",
    "features/onboarding/OnboardingScreen.tsx",
    "features/receive/RequestContactModal.tsx",
    "features/receive/RequestPaylinkModal.tsx",
    "features/requests/NewRequestLinkScreen.tsx",
    "features/paylink/usePaylinkDeps.ts",
    "features/paylink/LinkViewScreen.tsx",
    "features/withdraw/WithdrawToWalletModal.tsx",
    "features/deposit/DepositScreen.tsx",
    "features/deposit/DepositFromWalletModal.tsx",
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
        return path.join(fixtures, owner.endsWith("/features/requests/NewRequestLinkScreen.tsx") ? "request-readiness.ts" : "contexts.ts")
      }
      if (source === "@obsidion/sdk" && owner.endsWith("/features/requests/RequestLandingScreen.tsx")) {
        return path.join(fixtures, "request-node.ts")
      }
      const resolved = await this.resolve(source, importer, { skipSelf: true })
      if (owner.endsWith("/features/requests/NewRequestLinkScreen.tsx") && resolved?.id === path.join(walletDir, "src/features/onboarding/webRegistration.ts")) {
        return path.join(fixtures, "request-readiness.ts")
      }
      return resolved ? modules.get(resolved.id.split("?")[0]) ?? null : null
    },
  }
}
