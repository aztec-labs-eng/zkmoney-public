import {
  UpgradeActivity,
  legacyRecords,
  type Loaded,
  type OldVersionWithdrawal,
  type ReadonlyStore,
} from "@obsidion/front-core"
import { webStorage } from "../../platform/storage/WebStorageAdapter"
import { getOldVersionWithdrawalStore } from "../withdraw/oldVersionWithdrawals"

/** The rollup migration's page-wide stores, which every session of a page reads. */
export interface RollupMigrationStores {
  upgrades: UpgradeActivity
  /**
   * Built on the first read, which only an account's session makes: the page-wide store loads once,
   * so it must load after the wallet store opens and under the committed account.
   */
  oldVersionWithdrawals(): ReadonlyStore<Loaded<OldVersionWithdrawal>>
}

/** Built once per page: the mirror listens to the page-wide store for the page's life. */
export function rollupMigrationStores(): RollupMigrationStores {
  let oldVersionWithdrawals: ReadonlyStore<Loaded<OldVersionWithdrawal>> | undefined
  return {
    upgrades: UpgradeActivity.get(webStorage),
    oldVersionWithdrawals: () =>
      (oldVersionWithdrawals ??= legacyRecords(getOldVersionWithdrawalStore())),
  }
}
