import { chainUpgradeRun } from "@obsidion/front-core"
import { getConfig } from "../../config/env"
import type { SavingsAccount } from "../savings/AccountSwitcher"

/** The account a run pays into: `webMetadataMigrationKey` saves its destination portal as its second segment. */
export const upgradeRunAccount = (run: string): SavingsAccount =>
  run.split("/")[1] === getConfig().oxideProfile.portal.toLowerCase() ? "main" : "savings"

const inferredRun = chainUpgradeRun("")

/** The token a run credits: an inferred run (`chainUpgradeRun`) names it, else its account's. */
export const upgradeRunToken = (
  run: string,
  tokens: { main?: string; savings?: string },
): string | undefined =>
  run.startsWith(inferredRun) ? run.slice(inferredRun.length) : tokens[upgradeRunAccount(run)]
