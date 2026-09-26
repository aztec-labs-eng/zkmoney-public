/**
 * The escrow reader's `deployAndExecute` simulation decides whether a funded escrow is fillable or
 * parked for recovery, so what it sends matters: it pays its caller the tip, and a zero-address caller
 * makes every simulation revert on the ERC20 transfer.
 */
import { describe, expect, it, vi } from "vitest"
import { BaseError, ContractFunctionRevertedError, HttpRequestError } from "viem"
import { L1SwapEscrowReader } from "../../src/oxide/swapEscrowReader.js"

const FACTORY = "0x00000000000000000000000000000000000fac70"
const DAI = "0x6b175474e89094c44da98b954eedeac495271d0f"
const ESCROW = "0x000000000000000000000000000000000000e5e5"
const ARGS = {
  route: 0,
  recipient: "0x0000000000000000000000000000000000000b0b",
  recoveryCommitment: `0x${"5a".repeat(32)}`,
  relayerTip: 5n * 10n ** 18n,
  nonce: `0x${"11".repeat(32)}`,
} as const

const client = (simulate: () => Promise<unknown>, getContractEvents?: () => Promise<unknown>) =>
  ({
    simulateContract: vi.fn(simulate),
    readContract: vi.fn(async () => 7n),
    getCode: vi.fn(async () => "0x363d"),
    getBlockNumber: vi.fn(async () => 100n),
    getContractEvents: vi.fn(getContractEvents ?? (async () => [])),
  } as never)

describe("L1SwapEscrowReader.deploySimulates", () => {
  it("simulates as the committed recipient, never the zero address", async () => {
    const c = client(async () => ({}))
    const reader = new L1SwapEscrowReader(c, { dai: DAI })
    await expect(reader.deploySimulates(FACTORY, ARGS)).resolves.toBe(true)
    const call = (c as { simulateContract: ReturnType<typeof vi.fn> }).simulateContract.mock
      .calls[0]![0] as { account: string; address: string; functionName: string }
    expect(call.account).toBe(ARGS.recipient)
    expect(call.address).toBe(FACTORY)
    expect(call.functionName).toBe("deployAndExecute")
  })

  it("reads a contract revert as unfillable", async () => {
    const revert = new BaseError("execution reverted", {
      cause: new ContractFunctionRevertedError({ abi: [], functionName: "deployAndExecute" }),
    })
    const reader = new L1SwapEscrowReader(
      client(async () => {
        throw revert
      }),
      { dai: DAI },
    )
    await expect(reader.deploySimulates(FACTORY, ARGS)).resolves.toBe(false)
  })

  it("lets an RPC failure through, so the caller retries instead of parking the record", async () => {
    const reader = new L1SwapEscrowReader(
      client(async () => {
        throw new HttpRequestError({ url: "http://rpc", details: "socket hang up" })
      }),
      { dai: DAI },
    )
    await expect(reader.deploySimulates(FACTORY, ARGS)).rejects.toThrow(/socket hang up/)
  })
})

describe("L1SwapEscrowReader.executedTxHash", () => {
  it("is undefined when no SwapEscrowExecuted log is in the window", async () => {
    const reader = new L1SwapEscrowReader(
      client(async () => ({})),
      { dai: DAI },
    )
    await expect(reader.executedTxHash(FACTORY, ESCROW)).resolves.toBeUndefined()
  })

  it("returns the log's tx", async () => {
    const c = client(
      async () => ({}),
      async () => [{ transactionHash: `0x${"ab".repeat(32)}` }],
    )
    const reader = new L1SwapEscrowReader(c, { dai: DAI })
    await expect(reader.executedTxHash(FACTORY, ESCROW)).resolves.toBe(`0x${"ab".repeat(32)}`)
  })

  it("lets an RPC failure through instead of reading it as no log", async () => {
    const c = client(
      async () => ({}),
      async () => {
        throw new HttpRequestError({ url: "http://rpc", details: "socket hang up" })
      },
    )
    const reader = new L1SwapEscrowReader(c, { dai: DAI })
    await expect(reader.executedTxHash(FACTORY, ESCROW)).rejects.toThrow(/socket hang up/)
  })
})

describe("L1SwapEscrowReader.recoveredTxHash", () => {
  it("is undefined when no SwapEscrowRecovered log is in the window", async () => {
    const reader = new L1SwapEscrowReader(
      client(async () => ({})),
      { dai: DAI },
    )
    await expect(reader.recoveredTxHash(ESCROW)).resolves.toBeUndefined()
  })

  it("returns the log's tx and target, read from the escrow itself", async () => {
    const c = client(
      async () => ({}),
      async () => [{ transactionHash: `0x${"ab".repeat(32)}`, args: { target: ARGS.recipient } }],
    )
    const reader = new L1SwapEscrowReader(c, { dai: DAI })
    await expect(reader.recoveredTxHash(ESCROW)).resolves.toEqual({
      txHash: `0x${"ab".repeat(32)}`,
      target: ARGS.recipient,
    })
    expect(c.getContractEvents).toHaveBeenCalledWith(
      expect.objectContaining({ address: ESCROW, eventName: "SwapEscrowRecovered" }),
    )
  })

  it("lets an RPC failure through instead of reading it as no log", async () => {
    const c = client(
      async () => ({}),
      async () => {
        throw new HttpRequestError({ url: "http://rpc", details: "socket hang up" })
      },
    )
    const reader = new L1SwapEscrowReader(c, { dai: DAI })
    await expect(reader.recoveredTxHash(ESCROW)).rejects.toThrow(/socket hang up/)
  })
})

describe("L1SwapEscrowReader reads", () => {
  it("reads the escrow's DAI balance and code presence", async () => {
    const c = client(async () => ({}))
    const reader = new L1SwapEscrowReader(c, { dai: DAI })
    await expect(reader.daiBalance(ESCROW)).resolves.toBe(7n)
    await expect(reader.isDeployed(ESCROW)).resolves.toBe(true)
    ;(c as { getCode: ReturnType<typeof vi.fn> }).getCode.mockResolvedValueOnce(undefined)
    await expect(reader.isDeployed(ESCROW)).resolves.toBe(false)
  })
})
