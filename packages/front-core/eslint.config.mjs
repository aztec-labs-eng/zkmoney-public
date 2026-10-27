import { migrated } from "@obsidion/lint-config"

export default migrated({
  tsconfigRootDir: import.meta.dirname,
  engine: [
    "src/engine/**/*.ts",
    "src/core/paymentRequest/requestLinkMint.ts",
    "src/core/services/transactions/TransferEventScanner.ts",
    "src/core/services/transactions/WalletSyncCoordinator.ts",
  ],
  react: ["src/hooks/useStore.ts", "src/hooks/useAsset.ts", "src/contexts/useSavingsContext.tsx"],
  tests: [
    "test/engine/**/*.ts",
    "test/hooks/useStore.test.tsx",
    "test/core/failureReason.test.ts",
    "test/paymentRequest/requestLinkMint.test.ts",
    "test/services/transactions/transferScanCommit.test.ts",
    "test/services/transactions/TransferEventScanner.test.ts",
    "test/services/transactions/WalletSyncCoordinator.test.ts",
    "test/utils/xmtpReceiveFixtures.ts",
    "test/hooks/useSavings.test.tsx",
    "test/utils/activityFixture.ts",
    "test/services/pendingPaylinkMigration.test.ts",
  ],
})
