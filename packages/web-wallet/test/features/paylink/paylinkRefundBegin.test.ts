// @vitest-environment node
// The link codec's byte checks need one realm, which jsdom splits.
/** A link reads as refunding from the tap: its refund's operation names it as it begins. */
import { afterEach, expect, it } from "vitest"
import { Fr } from "@aztec-labs/aztec.js/fields"
import { Grumpkin } from "@aztec-labs/foundation/crypto/grumpkin"
import { DEFAULT_CONTRACTS } from "@obsidion/core/constants"
import { encodePaylinkInline, type PaylinkParams } from "@obsidion/sdk"
import {
  loadRecords,
  operationIndex,
  withOperation,
  type PaylinkTransaction,
} from "@obsidion/front-core"
import { recoverSponsoredLink } from "../../../src/features/paylink/sponsoredPaylink"
import { closeSession } from "../../../src/session/session"
import { openTestSession } from "../../support/session"

const NOW = 1_800_000_000
const params: PaylinkParams = {
  secret: new Fr(7n),
  paylinkType: DEFAULT_CONTRACTS.paylinkDirect,
  classId: new Fr(2n),
  chainId: 31337,
  fallbackKeyHash: new Fr(3n),
  rollupVersion: 1,
  escrowTagSecret: Grumpkin.generator,
}
const fragment = encodePaylinkInline(params)

afterEach(closeSession)

it("reads the link as refunding from the tap, before any chain read", async () => {
  let tip!: (block: unknown) => void
  const session = openTestSession({
    wallet: {
      networkId: "0xnet",
      node: { getBlockData: () => new Promise((resolve) => (tip = resolve)) },
    },
    account: { getAddress: () => ({ toString: () => `0x${"22".repeat(32)}` }) },
    contractService: {},
    teeSigner: {},
    token: {
      fetchTokenInformation: async () => ({
        address: "0xdai",
        name: "DAI",
        symbol: "DAI",
        decimals: 18,
      }),
    },
  })
  await session.transfers.importHistoricRows([
    {
      action: "Pay To Email",
      emailPaymentAction: "Pay To Email",
      flavor: "direct",
      status: "success",
      timestamp: (NOW - 600) * 1000,
      txHash: `0x${"ab".repeat(32)}`,
      paylink: `https://wallet.example/link#${fragment}`,
      payToEmailSecret: params.secret.toString(),
      fallbackSecret: `0x${"55".repeat(32)}`,
      obsidionAccountAddress: `0x${"11".repeat(32)}`,
      untilClaimable: NOW + 86_400,
      refundableUntil: NOW + 3_600,
    } as PaylinkTransaction,
  ])
  const deps = { session } as unknown as Parameters<typeof recoverSponsoredLink>[0]
  const run = recoverSponsoredLink(deps, fragment)
  const ops = openTestSession().operations.view
  await expect.poll(() => ops.get().records.length).toBe(1)
  const [link] = await loadRecords(openTestSession().paylinks.view)
  expect(withOperation(link, operationIndex(ops.get().records)).refunding).toBeDefined()
  tip({ header: { globalVariables: { timestamp: BigInt(NOW) } } })
  await expect(run).rejects.toThrow()
})
