import { MultiStepExecutorAbi } from "@oxide/l1-contracts/artifacts.js"
import { multiStepRecoveryDigest } from "@oxide/l1-contracts/multi_step/index.js"
import type { WithdrawArgs } from "@oxide/l1-contracts/oxide_portal.js"
import { decodeFunctionData, getAddress, type Hex } from "viem"
import { describe, expect, it } from "vitest"
import {
  buildMultiStepRecoverCall,
  readMultiStepRecovery,
} from "../../../src/oxide/withdrawal/multiStepRecovery.js"

const EXECUTOR = getAddress(`0x${"e5".repeat(20)}`)
const PORTAL = getAddress(`0x${"0a".repeat(20)}`)
const ACCOUNT = getAddress(`0x${"ac".repeat(20)}`)
const RECIPIENT = getAddress(`0x${"0d".repeat(20)}`)
const WITHDRAWAL = `0x${"1d".repeat(32)}` as Hex
const SALT = `0x${"5a".repeat(32)}` as Hex

const release: WithdrawArgs = {
  content: {
    executor: EXECUTOR,
    userPayloadHash: `0x${"00".repeat(32)}`,
    amount: 100n,
    proverTip: 3n,
    randomness: 7n,
  },
  userPayload: "0x",
  relayerPayload: "0x",
  epochNumber: 1n,
  numCheckpointsInEpoch: 1n,
  leafIndex: 0n,
  path: [],
  checkpointNumber: 2n,
  withdrawalId: WITHDRAWAL,
  teeSignature: "0x",
}

describe("buildMultiStepRecoverCall", () => {
  it("calls the executor's recover with the account's signature over Oxide's digest", async () => {
    const signed: Hex[] = []
    const call = await buildMultiStepRecoverCall({
      executor: EXECUTOR,
      portal: PORTAL,
      chainId: 31337n,
      release,
      recoverySalt: SALT,
      account: ACCOUNT,
      sign: async (digest) => {
        signed.push(digest)
        return "0x5167"
      },
      recipient: RECIPIENT,
      deadline: 99n,
    })
    expect(call.to).toBe(EXECUTOR)
    const digest = multiStepRecoveryDigest({
      executor: EXECUTOR,
      chainId: 31337n,
      withdrawalId: WITHDRAWAL,
      recipient: RECIPIENT,
      deadline: 99n,
    })
    expect(signed).toEqual([digest])
    const { functionName, args } = decodeFunctionData({
      abi: MultiStepExecutorAbi,
      data: call.data,
    })
    expect(functionName).toBe("recover")
    expect(args).toEqual([PORTAL, release, SALT, ACCOUNT, "0x5167", RECIPIENT, 99n])
  })

  it("reads the executor's recovery of one withdrawal in a block range, or none", async () => {
    const asked: unknown[] = []
    const log = {
      transactionHash: `0x${"7a".repeat(32)}`,
      blockNumber: 12n,
      args: { withdrawalId: WITHDRAWAL, recipient: RECIPIENT, amount: 97n },
    }
    const client = (logs: unknown[]) => ({
      getContractEvents: async (query: unknown) => {
        asked.push(query)
        return logs
      },
    })
    const range = { executor: EXECUTOR, withdrawalId: WITHDRAWAL, from: 10n, to: 14n }
    const read = (logs: unknown[]) =>
      readMultiStepRecovery(client(logs) as Parameters<typeof readMultiStepRecovery>[0], range)
    expect(await read([log])).toEqual({
      txHash: log.transactionHash,
      recipient: RECIPIENT,
      amount: 97n,
      blockNumber: 12n,
    })
    expect(await read([])).toBeUndefined()
    expect(asked[0]).toMatchObject({
      address: EXECUTOR,
      eventName: "Recovered",
      args: { withdrawalId: WITHDRAWAL },
      fromBlock: 10n,
      toBlock: 14n,
    })
  })
})
