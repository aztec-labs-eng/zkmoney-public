import { describe, expect, it } from "vitest"
import { Fr } from "@aztec-labs/aztec.js/fields"
import { EthAddress } from "@aztec-labs/foundation/eth-address"
import { AztecAddress } from "@aztec-labs/stdlib/aztec-address"
import { TxHash } from "@aztec-labs/stdlib/tx"
import { encodePlainWithdrawalPayload } from "@oxide/oxide-lib/plain_withdrawal_executor.js"
import { computeWithdrawalId } from "@oxide/oxide-lib/hash.js"
import type { Address, Hex } from "viem"
import { HOLDING_ADAPTERS } from "../../../src/oxide/holdings/adapters.js"
import type { MoveDirection } from "../../../src/oxide/holdings/conversion.js"
import { readHoldingRoute } from "../../../src/oxide/holdings/holdingDeployment.js"
import { readVaultMove, readVaultMoveBurns } from "../../../src/oxide/holdings/moveBurns.js"
import { buildMove } from "../../../src/oxide/holdings/moveRoute.js"
import { encodeWithdrawalMemo } from "../../../src/services/withdrawal/withdrawalMemo.js"
import {
  DAI,
  EXECUTOR,
  HELD_PORTAL,
  MAIN_PORTAL,
  fakeChain,
  vaultHolding,
} from "./holdingFixtures.js"

const NONCE = `0x${"aa".repeat(32)}` as Hex
const COMMITMENT = `0x${"01".repeat(32)}` as Hex
const MEMO = encodeWithdrawalMemo({ vaultMove: { nonce: NONCE } })

/** The recovery data of a real move's burn, as `recoverWithdrawals` returns it. */
async function burnOf(
  conversion: "None" | "DaiUsds",
  direction: MoveDirection,
  memo: Buffer = MEMO,
) {
  const chain = conversion === "None" ? fakeChain(DAI) : fakeChain()
  const route = await readHoldingRoute(chain, HOLDING_ADAPTERS, vaultHolding(conversion))
  const { operation } = buildMove(route, {
    direction,
    minOut: 7n,
    conversionMinOut: 9n,
    recipientCommitment: COMMITMENT,
    from: AztecAddress.fromNumberUnsafe(2),
    amount: 1_000n,
    proverTip: 1n,
    relayerTip: 2n,
    recovery: { salt: new Fr(3n), account: `0x${"0a".repeat(20)}` as Address },
    recoveryMemo: memo,
  })
  return {
    finalizationData: {
      executor: operation.executor,
      amount: operation.amount,
      proverTip: operation.proverTip,
      userPayload: operation.userPayload,
    },
    memo: operation.recoveryMemo!,
  } as unknown as Parameters<typeof readVaultMove>[0]
}

describe("readVaultMove", () => {
  it.each([
    ["None", "in", HELD_PORTAL],
    ["None", "out", MAIN_PORTAL],
    ["DaiUsds", "in", HELD_PORTAL],
    ["DaiUsds", "out", MAIN_PORTAL],
  ] as const)(
    "reads a %s move %s's nonce and the deposit its route makes",
    async (conversion, direction, destination) => {
      expect(readVaultMove(await burnOf(conversion, direction), [EXECUTOR])).toEqual({
        amount: 1_000n,
        nonce: NONCE,
        destination,
        recipientCommitment: COMMITMENT,
      })
    },
  )

  it("reads nothing of a burn to another executor or without a vault move memo", async () => {
    const burn = await burnOf("DaiUsds", "in")
    expect(readVaultMove(burn, [`0x${"e2".repeat(20)}` as Address])).toBeUndefined()
    expect(readVaultMove({ ...burn, memo: Buffer.alloc(0) }, [EXECUTOR])).toBeUndefined()
  })

  it("reads nothing of a vault move memo over a route that is no move's", async () => {
    const burn = await burnOf("DaiUsds", "in")
    const userPayload = encodePlainWithdrawalPayload({
      recipient: EthAddress.fromNumber(0xa1),
      relayerTip: 2n,
    })
    const plain = { ...burn, finalizationData: { ...burn.finalizationData, userPayload } }
    expect(readVaultMove(plain, [EXECUTOR])).toBeUndefined()
  })
})

describe("readVaultMoveBurns", () => {
  const TX = TxHash.fromField(new Fr(7n))
  const PENDING = TxHash.fromField(new Fr(8n))
  const UNINDEXED = TxHash.fromField(new Fr(9n))

  it("returns each move with its withdrawal id, and reads later what the node has not indexed", async () => {
    const burn = await burnOf("DaiUsds", "out")
    const withdrawal = (txHash: TxHash) => ({ ...burn, txHash, messageHash: new Fr(1n) })
    const recovered = {
      withdrawals: [withdrawal(TX), withdrawal(PENDING)],
      failures: [{ txHash: UNINDEXED, reason: "no effect" }],
    } as unknown as Parameters<typeof readVaultMoveBurns>[0]
    const node = {
      getTxEffect: async () => undefined,
      getTxReceipt: async (tx: TxHash) => (tx.equals(TX) ? { blockNumber: 3 } : {}),
    } as unknown as Parameters<typeof readVaultMoveBurns>[1]["node"]

    expect(await readVaultMoveBurns(recovered, { node, executors: [EXECUTOR] })).toEqual({
      burns: [
        {
          amount: 1_000n,
          nonce: NONCE,
          destination: MAIN_PORTAL,
          recipientCommitment: COMMITMENT,
          txHash: TX.toString(),
          blockNumber: 3,
          withdrawalId: computeWithdrawalId(TX, new Fr(1n)).toString(),
        },
      ],
      unread: [UNINDEXED.toString(), PENDING.toString()],
    })
  })
})
