import { createAztecNodeClient, type AztecNode } from "@aztec/aztec.js/node"
import { BlockNumber } from "@aztec/foundation/branded-types"
import { defaultFetch } from "@aztec/foundation/json-rpc/client"
import { AZTEC_API_KEY_HEADER } from "@obsidion/core/constants"

/**
 * How long a client reuses one `getNodeInfo` answer.
 *
 * Node info is deployment identity — rollup and protocol contract addresses, versions, the
 * network's per-tx limits — so it does not move with the chain the way a block or a note does.
 * Bounded rather than permanent because `txsLimits` feeds the gas limits on every send, and an
 * operator retuning a live node should reach the wallet without a reload.
 */
export const NODE_INFO_TTL_MS = 5 * 60_000

/**
 * Serve `getNodeInfo` from one answer per client, and the genesis block from one answer ever.
 *
 * Over twenty call sites reach for node info — account construction, gas settings, registration,
 * the paylink sweep — and each one was a round-trip carrying the whole node descriptor. The genesis
 * block never changes; PXE creation reads it, so a boot can fetch it early and PXE gets it free.
 * The promise is what gets held, so concurrent callers share a single in-flight request; a rejected
 * read is dropped so the next caller retries rather than inheriting the failure.
 */
function withNodeMemo(node: AztecNode): AztecNode {
  let cached: { at: number; info: Promise<unknown> } | null = null
  let genesis: Promise<unknown> | null = null

  const getNodeInfo = () => {
    if (cached && Date.now() - cached.at < NODE_INFO_TTL_MS) return cached.info
    const info = node.getNodeInfo()
    cached = { at: Date.now(), info }
    info.catch(() => {
      if (cached?.info === info) cached = null
    })
    return info
  }

  // Options change the block's shape, so only the bare read is held.
  const getBlock = (...args: Parameters<AztecNode["getBlock"]>) => {
    if (args.length !== 1 || args[0] !== BlockNumber.ZERO) return node.getBlock(...args)
    if (genesis) return genesis
    const block = node.getBlock(BlockNumber.ZERO)
    genesis = block
    block.catch(() => {
      if (genesis === block) genesis = null
    })
    return block
  }

  return new Proxy(node, {
    get(target, property) {
      if (property === "getNodeInfo") return getNodeInfo
      if (property === "getBlock") return getBlock
      const value = Reflect.get(target, property)
      // Bind to the target, never the proxy: the client underneath is itself a proxy that
      // synthesizes methods per read, and handing it a different receiver re-enters this trap.
      return typeof value === "function" ? value.bind(target) : value
    },
  }) as AztecNode
}

/**
 * The single node-client factory for the monorepo, so API-key threading lives in one place.
 *
 * It builds a client per call, and who keeps one is the caller's business: a front's composition
 * root builds one and passes it down, a backend that wants several builds several.
 *
 * A node behind an API gateway rejects unauthenticated JSON-RPC with 403; the key rides every
 * request as {@link AZTEC_API_KEY_HEADER}, injected by wrapping the client's fetch. Passing no
 * key produces a plain unauthenticated client, which is what an open node (sandbox) wants.
 */
export function createNode(url: string, apiKey?: string, batchWindowMS?: number): AztecNode {
  const fetch: typeof defaultFetch | undefined = apiKey
    ? (host, body, extraHeaders = {}, noRetry = false) =>
        defaultFetch(host, body, { ...extraHeaders, [AZTEC_API_KEY_HEADER]: apiKey }, noRetry)
    : undefined

  return withNodeMemo(createAztecNodeClient(url, undefined, fetch, batchWindowMS))
}
