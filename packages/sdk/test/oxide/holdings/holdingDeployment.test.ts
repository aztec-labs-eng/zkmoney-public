import { describe, expect, it } from "vitest"
import { adapters, withdrawalRoute } from "@oxide/l1-contracts/multi_step/index.js"
import type { MultiStepPayload } from "@oxide/l1-contracts/multi_step/index.js"
import type { Address, Hex } from "viem"
import { HOLDING_ADAPTERS } from "../../../src/oxide/holdings/adapters.js"
import {
  assertRouteOnExecutor,
  readHoldingDeployment,
  readHoldingRoute,
} from "../../../src/oxide/holdings/holdingDeployment.js"
import { termsAdapters } from "../../../src/oxide/holdings/terms.js"
import {
  ERC4626_ADAPTER,
  EXECUTOR,
  MULTI_STEP,
  PORTAL_DEPOSIT_ADAPTER,
  USDS,
  USDS_VAULT,
  VAULT,
  fakeChain,
  vaultHolding,
} from "./holdingFixtures.js"

describe("readHoldingDeployment", () => {
  it("binds a vault to the manifest's executor and bridges, and reads its chain and asset", async () => {
    const client = {
      getChainId: async () => 1,
      readContract: async (read: { address: Address; functionName: string }) => {
        if (read.address === VAULT && read.functionName === "asset") return USDS.toLowerCase()
        throw new Error(`unexpected read ${read.functionName} on ${read.address}`)
      },
    }
    expect(await readHoldingDeployment(client as never, vaultHolding("DaiUsds"))).toEqual(
      USDS_VAULT,
    )
  })
})

describe("readHoldingRoute", () => {
  it("binds a vault's terms and conversion on its deployment", async () => {
    const route = await readHoldingRoute(fakeChain(), HOLDING_ADAPTERS, vaultHolding("DaiUsds"))
    expect(route.deployment).toEqual(USDS_VAULT)
    expect(route.terms.steps("in", 1n).map((step) => step.fn)).toEqual(["erc4626Deposit"])
    expect(route.conversion.steps("in", 1n).map((step) => step.fn)).toEqual(["daiToUsds"])
  })

  it("refuses a vault whose terms have no implementation", async () => {
    const adapters = { ...HOLDING_ADAPTERS, terms: termsAdapters() }
    await expect(
      readHoldingRoute(fakeChain(), adapters, vaultHolding("DaiUsds")),
    ).rejects.toMatchObject({ code: "holding.unsupported" })
  })

  it("reads a failed read as an unread route", async () => {
    const chain = { ...fakeChain(), getChainId: () => Promise.reject(new Error("rpc down")) }
    await expect(
      readHoldingRoute(chain, HOLDING_ADAPTERS, vaultHolding("DaiUsds")),
    ).rejects.toMatchObject({ code: "move.routeUnread" })
  })
})

describe("assertRouteOnExecutor", () => {
  const { erc4626, portalDeposit } = adapters({
    chainId: 1n,
    configs: {
      erc4626: { address: ERC4626_ADAPTER },
      portalDeposit: { address: PORTAL_DEPOSIT_ADAPTER },
    },
  })
  const route = withdrawalRoute({ token: USDS }).remainder((lane) =>
    lane.step(erc4626.deposit({ vault: { asset: USDS, share: VAULT }, minOut: 1n })).end(
      portalDeposit.deposit({
        portal: { address: USDS_VAULT.held.portal, asset: VAULT },
        recipientCommitment: `0x${"01".repeat(32)}`,
      }),
    ),
  )
  const payload: MultiStepPayload = {
    relayerTip: 1n,
    recoveryCommitment: `0x${"02".repeat(32)}`,
    remainderRecipient: route.remainderRecipient!,
    transfers: route.transfers,
    steps: route.steps,
  }
  const stranger = `0x${"99".repeat(20)}` as Address

  it("takes a move the manifest's executor runs through its adapters", () => {
    expect(() => assertRouteOnExecutor({ executor: EXECUTOR, payload }, MULTI_STEP)).not.toThrow()
  })

  it.each([
    { name: "another executor", executor: stranger, payload },
    {
      name: "funds to a stranger",
      executor: EXECUTOR,
      payload: { ...payload, remainderRecipient: stranger },
    },
    {
      name: "a call to a stranger",
      executor: EXECUTOR,
      payload: { ...payload, steps: [...payload.steps, { target: stranger, data: "0x" as Hex }] },
    },
    {
      name: "a transfer to a stranger",
      executor: EXECUTOR,
      payload: { ...payload, transfers: [{ amount: 1n, recipient: stranger }] },
    },
  ])("refuses $name", ({ executor, payload }) => {
    expect(() => assertRouteOnExecutor({ executor, payload }, MULTI_STEP)).toThrow(
      expect.objectContaining({ code: "move.routeMismatch" }),
    )
  })
})
