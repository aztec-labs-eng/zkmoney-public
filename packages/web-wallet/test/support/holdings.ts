import type { DeploymentHoldings, OxideBridge, SkyEscrowHolding } from "@obsidion/core/oxide"

/** A Sky holding whose held bridge is `held`, as far as a reader keys on it. */
export const skyHolding = (held: Partial<OxideBridge>, id = "fea-sky"): SkyEscrowHolding =>
  ({
    id,
    kind: "yield",
    rail: "skyEscrow",
    l2Token: held.l2Token,
    held,
    base: {},
    terms: "erc4626",
    conversion: "DaiUsds",
    escrow: { factory: `0x${"fa".repeat(20)}`, withdrawalExecutor: `0x${"e5".repeat(20)}` },
  } as SkyEscrowHolding)

/** A deployment's holdings: one Sky holding per held bridge. */
export const holdingsOf = (...held: Partial<OxideBridge>[]): DeploymentHoldings => ({
  holdings: held.map((bridge, i) => skyHolding(bridge, `fea-sky-${i}`)),
  rejected: [],
})
