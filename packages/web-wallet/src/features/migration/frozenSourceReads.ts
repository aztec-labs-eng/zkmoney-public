import type { Fr } from "@aztec/aztec.js/fields"
import type { OxideEnvTuple } from "@obsidion/core/types"
import type { ObsidionAccount, ObsidionWallet } from "@obsidion/sdk"
import type { PublicClient } from "viem"
import { sourceFrozenEscrows } from "./sourceFrozenEscrows"
import { sourceSweptDeposits } from "./sourceSipaSources"

/** The account's swept deposits and payment link escrows on a frozen deployment, for its refunds. */
export function frozenSourceReads(o: {
  chain: { wallet: ObsidionWallet; account: ObsidionAccount }
  tuple: OxideEnvTuple
  current: OxideEnvTuple
  client: PublicClient
  masterSecret: Fr
  storageId: string
}) {
  return {
    depositDescriptors: async () =>
      (
        await sourceSweptDeposits({
          chain: o.chain,
          tuple: o.tuple,
          current: o.current,
          publicClient: o.client,
          masterSecret: o.masterSecret,
          scanHead: await o.client.getBlockNumber({ cacheTime: 0 }),
        })
      ).descriptors,
    escrows: () =>
      sourceFrozenEscrows({
        chain: o.chain,
        tuple: o.tuple,
        current: o.current,
        masterSecret: o.masterSecret,
        storageId: o.storageId,
      }),
  }
}
