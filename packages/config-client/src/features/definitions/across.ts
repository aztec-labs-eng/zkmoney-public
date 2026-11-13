import { z } from "zod"
import type { OxideDeployment } from "@obsidion/core/oxide"
import type { OxideEnvTuple, OxideFeature } from "@obsidion/core/types"
import { assetSymbol, httpUrl, l1Address, nonEmpty } from "../../fields.js"
import {
  defineFeature,
  type FeatureContext,
  type FeatureEntry,
  type FeatureIssue,
} from "../define.js"
import { resolveOxideRole } from "../oxideRole.js"

type Erc20Token = { symbol: string; address: string; comingSoon?: true }
type NativeToken = { symbol: string; native: true; comingSoon?: true }

/**
 * An ERC-20 by `address`, or the chain's gas token by `native`. One strict object, not a union of
 * two: a key a later build adds then fails as an unknown key, which a served document drops,
 * rather than as a union no branch matched, which turns the whole feature off.
 */
const inToken = z
  .strictObject({
    symbol: assetSymbol,
    address: l1Address.optional(),
    native: z.literal(true).optional(),
    comingSoon: z.literal(true).optional(),
  })
  .refine((t) => (t.address === undefined) !== (t.native === undefined), {
    message: "names exactly one of address and native",
  })
  .transform((t) => t as Erc20Token | NativeToken)

/** Oxide's Across escrow swaps DAI to these on L1 before bridging; nothing else can leave. */
export const ACROSS_OUT_SYMBOLS = ["USDC", "USDT"] as const

const outToken = z.strictObject({
  symbol: z.enum(ACROSS_OUT_SYMBOLS),
  address: l1Address,
  comingSoon: z.literal(true).optional(),
})

const acrossSchema = z.strictObject({
  apiUrl: httpUrl,
  /** Across's MulticallHandler on the L1. Without it no deposit that carries a message quotes. */
  multicallHandler: l1Address.optional(),
  chains: z.array(
    z.strictObject({
      chainId: z.int().positive(),
      name: nonEmpty,
      etaMinutes: z.int().positive(),
      rpcUrl: httpUrl,
      /** Tokens a wallet on this chain can bridge in. */
      in: z.array(inToken),
      /** Tokens a withdrawal can land here. Needs the `exit` role. */
      out: z.array(outToken).optional(),
      /**
       * Across's SpokePool and periphery here: the only contracts a bridge-in call and its
       * approvals may name. Without them the chain quotes nothing.
       */
      contracts: z.array(l1Address).min(1).optional(),
    }),
  ),
})

function checkChains(
  { chains }: z.infer<typeof acrossSchema>,
  { l1ChainId }: FeatureContext,
): FeatureIssue[] {
  const issues: FeatureIssue[] = []
  const chainIds = new Set<number>()
  chains.forEach((chain, index) => {
    const at = ["chains", index]
    if (chain.chainId === l1ChainId)
      issues.push({ message: `lists the L1 chain ${chain.chainId}`, path: [...at, "chainId"] })
    if (chainIds.has(chain.chainId))
      issues.push({ message: `lists chain ${chain.chainId} twice`, path: [...at, "chainId"] })
    chainIds.add(chain.chainId)
    for (const direction of ["in", "out"] as const) {
      const symbols = new Set<string>()
      chain[direction]?.forEach((entry, tokenIndex) => {
        if (symbols.has(entry.symbol))
          issues.push({
            message: `lists ${entry.symbol} twice on chain ${chain.chainId}`,
            path: [...at, direction, tokenIndex, "symbol"],
          })
        symbols.add(entry.symbol)
      })
    }
  })
  return issues
}

/** The escrow withdraws DAI from the bridge bound as `dai`. */
const EXIT_ROLE = {
  project: "across",
  contracts: ["acrossBridgeEscrowFactory"],
  bridges: ["dai"],
  optional: true,
} as const

export const acrossFeature = defineFeature({
  id: "across",
  schema: acrossSchema,
  oxide: { exit: EXIT_ROLE },
  check: checkChains,
  onChain: ({ multicallHandler, chains }) => ({
    l1Contracts: multicallHandler
      ? [{ path: ["multicallHandler"], address: multicallHandler }]
      : [],
    chains: chains.map((chain, index) => ({
      path: ["chains", index],
      chainId: chain.chainId,
      rpcUrl: chain.rpcUrl,
      contracts: (chain.contracts ?? []).map((address, i) => ({
        path: ["chains", index, "contracts", i],
        address,
      })),
      tokens: (["in", "out"] as const).flatMap((direction) =>
        (chain[direction] ?? []).flatMap((token, i) =>
          "address" in token
            ? [
                {
                  path: ["chains", index, direction, i],
                  address: token.address,
                  symbol: token.symbol,
                },
              ]
            : [],
        ),
      ),
    })),
  }),
})

/** The Across bridge a features document offers: the `across` entry. */
export type AcrossBridge = FeatureEntry<typeof acrossFeature>
export type AcrossChain = AcrossBridge["chains"][number]
export type BridgeToken = AcrossChain["in"][number]

/** The Oxide feature Across bridges out through, and the bridges of the deployment it is in. */
export interface AcrossExit {
  feature: OxideFeature
  pinnedBridges: ReadonlySet<string>
}

/** `across`'s `exit` role in the pinned `deployment`; absent, nothing bridges out through Across. */
export function acrossExit(
  across: AcrossBridge,
  deployment: OxideDeployment,
): AcrossExit | undefined {
  if (!across.oxide.exit) return undefined
  const feature = resolveOxideRole(deployment, EXIT_ROLE, across.oxide.exit)
  if ("code" in feature) return undefined
  return {
    feature,
    pinnedBridges: new Set(deployment.bridges.flatMap((bridge) => bridge.id ?? [])),
  }
}

/**
 * The escrow factory a burn from `tuple`'s bridge pays. On the pinned deployment it is `exit`'s,
 * for the bridge it binds as `dai`. A deployment the profile left keeps the one its own manifest
 * entry names: a features document binds only the pinned deployment's features.
 */
export function acrossEscrowFactory(
  exit: AcrossExit | undefined,
  tuple: Pick<OxideEnvTuple, "bridgeId" | "acrossBridgeEscrowFactory">,
): string | undefined {
  if (!exit) return undefined
  if (tuple.bridgeId === undefined || !exit.pinnedBridges.has(tuple.bridgeId))
    return tuple.acrossBridgeEscrowFactory
  return exit.feature.bridges.dai === tuple.bridgeId
    ? exit.feature.contracts.acrossBridgeEscrowFactory
    : undefined
}
