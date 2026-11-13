import { describe, expect, it } from "vitest"
import { Fr } from "@aztec-labs/aztec.js/fields"
import { AztecAddress } from "@aztec-labs/stdlib/aztec-address"
import type { Address, Hex } from "viem"
import { HOLDING_ADAPTERS } from "../../../src/oxide/holdings/adapters.js"
import {
  assertRouteOnExecutor,
  readHoldingRoute,
} from "../../../src/oxide/holdings/holdingDeployment.js"
import {
  MOVE_RECOVERY_CHUNKS,
  assertMoveFits,
  buildMove,
  compileMove,
} from "../../../src/oxide/holdings/moveRoute.js"
import type { MoveArgs } from "../../../src/oxide/holdings/moveRoute.js"
import {
  ERC4626_ADAPTER,
  EXECUTOR,
  MULTI_STEP,
  PORTAL_DEPOSIT_ADAPTER,
  SKY_CONVERTER_ADAPTER,
  fakeChain,
  vaultHolding,
} from "./holdingFixtures.js"

const COMMITMENT = `0x${"01".repeat(32)}` as Hex
const route = () => readHoldingRoute(fakeChain(), HOLDING_ADAPTERS, vaultHolding("DaiUsds"))

const move = (over: Partial<MoveArgs> = {}): MoveArgs => ({
  direction: "in",
  minOut: 7n,
  conversionMinOut: 9n,
  recipientCommitment: COMMITMENT,
  from: AztecAddress.fromNumberUnsafe(2),
  amount: 1_000n,
  proverTip: 1n,
  relayerTip: 2n,
  recovery: { salt: new Fr(3n), account: `0x${"0a".repeat(20)}` as Address },
  recoveryMemo: Buffer.from([1, 2, 3]),
  ...over,
})

const calls = (direction: "in" | "out") =>
  route().then((r) => compileMove(r, move({ direction })).calls)

describe("compileMove", () => {
  it("converts, then deposits into the vault, then into the vault's portal, moving in", async () => {
    expect(await calls("in")).toEqual([
      { target: SKY_CONVERTER_ADAPTER, call: "daiToUsds" },
      { target: ERC4626_ADAPTER, call: "erc4626Deposit" },
      { target: PORTAL_DEPOSIT_ADAPTER, call: "portalDeposit" },
    ])
  })

  it("redeems, then converts back, then deposits into the base's portal, moving out", async () => {
    expect(await calls("out")).toEqual([
      { target: ERC4626_ADAPTER, call: "erc4626Redeem" },
      { target: SKY_CONVERTER_ADAPTER, call: "usdsToDai" },
      { target: PORTAL_DEPOSIT_ADAPTER, call: "portalDeposit" },
    ])
  })
})

describe("buildMove", () => {
  it("burns to the executor a route that runs on its adapters, carrying the memo", async () => {
    const built = buildMove(await route(), move())
    expect(built.operation.executor.toString()).toBe(EXECUTOR.toLowerCase())
    expect(built.operation.recoveryMemo).toEqual(Buffer.from([1, 2, 3]))
    expect(built.payload.relayerTip).toBe(2n)
    expect(() =>
      assertRouteOnExecutor({ executor: EXECUTOR, payload: built.payload }, MULTI_STEP),
    ).not.toThrow()
    expect(built.recoveryChunks).toBeLessThanOrEqual(MOVE_RECOVERY_CHUNKS)
  })

  it("refuses a move whose recovery data outgrows a sponsored withdrawal", async () => {
    const holding = await route()
    const memo = Buffer.alloc(2_000)
    expect(() => buildMove(holding, move({ recoveryMemo: memo }))).toThrow(
      expect.objectContaining({ code: "move.routeTooLong" }),
    )
    expect(() => assertMoveFits(holding, "out", memo)).toThrow(
      expect.objectContaining({ code: "move.routeTooLong" }),
    )
    expect(() => assertMoveFits(holding, "out", Buffer.alloc(0))).not.toThrow()
  })
})
