/**
 * Dev demo: Receive's code without a wallet. The deposit fixture address stands in for a pooled one,
 * and the request is minted but not stored. The token stands in too: the L2 fixture is not a field.
 */
import { Fr } from "@aztec/aztec.js/fields"
import { mintRequestLink } from "@obsidion/front-core"
import { receiveCodeKey, type CodeDeps } from "../features/receive/receiveCode"
import type { CodePayment } from "../features/receive/useReceiveCode"
import { demoDepositAddress } from "./demoDeposit"

export function demoCodeDeps(tag: string): CodeDeps {
  return {
    key: receiveCodeKey("demo", tag),
    readyAddress: async () => ({
      address: demoDepositAddress(tag).address,
      day: Math.floor(Date.now() / 86_400_000),
    }),
    mint: async (args) =>
      mintRequestLink({
        requestId: Fr.random().toString(),
        requesterTag: tag,
        tokenAddress: `0x0${"5c".repeat(31)}c`,
        tokenDecimals: 6,
        tokenSymbol: "USDC",
        networkId: `0x${"de".repeat(20)}`,
        baseUrl: location.origin,
        ...args,
      }),
    cancel: async () => {},
    paid: async () => false,
  }
}

/** `?mock=paid` or `?mock=onchain` shows a paid code, for reviewing frames 5 and 6. */
export function demoPayment(search: string): CodePayment | undefined {
  const mock = new URLSearchParams(search).get("mock")
  if (mock === "paid")
    return { via: "private", amount: 12.5, payer: "@bob", added: true, hadAddress: true }
  if (mock === "onchain") return { via: "ethereum", amount: 12.5, hadAddress: true }
  return undefined
}
