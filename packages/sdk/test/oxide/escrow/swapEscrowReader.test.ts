/**
 * The escrow reader's `deployAndExecute` simulation decides whether a funded escrow is fillable or
 * parked for recovery, so what it sends matters: it pays its caller the tip, and a zero-address caller
 * makes every simulation revert on the ERC20 transfer.
 */
import { describe, expect, it, vi } from "vitest"
import {
  type Abi,
  type AbiEvent,
  BaseError,
  CallExecutionError,
  ContractFunctionRevertedError,
  ExecutionRevertedError,
  HttpRequestError,
  RawContractError,
  getAbiItem,
  toEventSelector,
} from "viem"
import { LegacySwapEscrowEventsAbi, SwapEscrowAbi, SwapEscrowFactoryAbi } from "@oxide/l1-contracts"
import { L1SwapEscrowReader } from "../../../src/oxide/escrow/swapEscrowReader.js"
import { encodeSwapEscrowExecute } from "../../../src/oxide/escrow/swapOnWithdraw.js"

const FACTORY = "0x00000000000000000000000000000000000fac70"
const DAI = "0x6b175474e89094c44da98b954eedeac495271d0f"
const ESCROW = "0x000000000000000000000000000000000000e5e5"
const LEGACY_ARGS = {
  route: 0,
  recipient: "0x0000000000000000000000000000000000000b0b",
  recoveryCommitment: `0x${"5a".repeat(32)}`,
  relayerTip: 5n * 10n ** 18n,
  nonce: `0x${"11".repeat(32)}`,
} as const
const ARGS = { ...LEGACY_ARGS, daiForGas: 0n, minEthForGas: 0n }
const V2 = { layout: "v2", args: ARGS } as const

const client = (
  call: () => Promise<unknown>,
  getContractEvents?: (query: {
    address: string
    eventName: string
    args?: { escrow?: string }
    toBlock?: bigint
  }) => Promise<unknown>,
) =>
  ({
    call: vi.fn(call),
    readContract: vi.fn(async () => 7n),
    getCode: vi.fn(async () => "0x363d"),
    getBlockNumber: vi.fn(async () => 100n),
    getContractEvents: vi.fn(getContractEvents ?? (async () => [])),
  } as never)

describe("L1SwapEscrowReader.deploySimulates", () => {
  const RUN = encodeSwapEscrowExecute(V2)

  it("calls the factory with the run's calldata as the given payee", async () => {
    const c = client(async () => ({}))
    const reader = new L1SwapEscrowReader(c, { dai: DAI })
    await expect(reader.deploySimulates(FACTORY, RUN, ARGS.recipient)).resolves.toBe(true)
    const call = (c as { call: ReturnType<typeof vi.fn> }).call.mock.calls[0]![0]
    expect(call).toEqual({ to: FACTORY, data: RUN, account: ARGS.recipient })
  })

  it.each([
    [
      "a decoded revert",
      new BaseError("execution reverted", {
        cause: new ContractFunctionRevertedError({ abi: [], functionName: "deployAndExecute" }),
      }),
    ],
    ["a node's revert", new CallExecutionError(new ExecutionRevertedError(), {})],
    ["revert data", new CallExecutionError(new RawContractError({ data: "0x1234" }), {})],
  ])("reads %s as unfillable", async (_, revert) => {
    const reader = new L1SwapEscrowReader(
      client(async () => {
        throw revert
      }),
      { dai: DAI },
    )
    await expect(reader.deploySimulates(FACTORY, RUN, ARGS.recipient)).resolves.toBe(false)
  })

  it("lets an RPC failure through, so the caller retries instead of parking the record", async () => {
    const reader = new L1SwapEscrowReader(
      client(async () => {
        throw new HttpRequestError({ url: "http://rpc", details: "socket hang up" })
      }),
      { dai: DAI },
    )
    await expect(reader.deploySimulates(FACTORY, RUN, ARGS.recipient)).rejects.toThrow(
      /socket hang up/,
    )
  })
})

/** Logs a factory or escrow emitted, answered the way `getContractEvents` filters them. */
const chain =
  (logs: { address: string; eventName: string; escrow?: string; transactionHash: string }[]) =>
  async (query: { address: string; eventName: string; args?: { escrow?: string } }) =>
    logs
      .filter(
        (log) =>
          log.address === query.address &&
          log.eventName === query.eventName &&
          (query.args?.escrow === undefined || log.escrow === query.args.escrow),
      )
      .map((log) => ({ transactionHash: log.transactionHash, args: { target: ARGS.recipient } }))

describe("L1SwapEscrowReader.executedTxHash", () => {
  it.each(["EscrowExecuted", "SwapEscrowExecuted"])(
    "finds this escrow's %s log, past another escrow's",
    async (eventName) => {
      const c = client(
        async () => ({}),
        chain([
          { address: FACTORY, eventName, escrow: `0x${"99".repeat(20)}`, transactionHash: "0x01" },
          { address: FACTORY, eventName, escrow: ESCROW, transactionHash: "0x02" },
        ]),
      )
      const reader = new L1SwapEscrowReader(c, { dai: DAI })
      await expect(reader.executedTxHash(FACTORY, ESCROW)).resolves.toBe("0x02")
    },
  )

  it("is undefined when no execution log is in the window", async () => {
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

  it("scans to the live head, not a cached one, so the latest block's execution is found", async () => {
    const c = {
      ...(client(
        async () => ({}),
        async ({ toBlock }) =>
          toBlock !== undefined && toBlock >= 101n ? [{ transactionHash: "0x03" }] : [],
      ) as object),
      // viem answers from its cache unless told not to; the execution landed in block 101.
      getBlockNumber: vi.fn(async (args?: { cacheTime?: number }) =>
        args?.cacheTime === 0 ? 101n : 100n,
      ),
    } as never
    const reader = new L1SwapEscrowReader(c, { dai: DAI })
    await expect(reader.executedTxHash(FACTORY, ESCROW)).resolves.toBe("0x03")
  })
})

describe("L1SwapEscrowReader.recoveredTxHash", () => {
  it.each(["EscrowRecovered", "SwapEscrowRecovered"])(
    "finds the escrow's own %s log",
    async (eventName) => {
      const c = client(
        async () => ({}),
        chain([
          { address: `0x${"99".repeat(20)}`, eventName, transactionHash: "0x01" },
          { address: ESCROW, eventName, transactionHash: "0x02" },
        ]),
      )
      const reader = new L1SwapEscrowReader(c, { dai: DAI })
      await expect(reader.recoveredTxHash(ESCROW)).resolves.toEqual({
        txHash: "0x02",
        target: ARGS.recipient,
      })
    },
  )

  it("is undefined when no recovery log is in the window", async () => {
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
    for (const eventName of ["EscrowRecovered", "SwapEscrowRecovered"]) {
      expect((c as { getContractEvents: unknown }).getContractEvents).toHaveBeenCalledWith(
        expect.objectContaining({ address: ESCROW, eventName }),
      )
    }
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

// oxide exports the pre-`EscrowBase` names without a test of its own; the prod v6 factory and escrow
// emit exactly these topics (their bytecode carries them).
describe("the legacy swap-escrow events", () => {
  it.each([
    [
      "SwapEscrowExecuted",
      "EscrowExecuted",
      SwapEscrowFactoryAbi,
      "0xe2a7af9cee4346563aea77a4704d23c228387fb042a1890f6f97b13062ad030a",
    ],
    [
      "SwapEscrowRecovered",
      "EscrowRecovered",
      SwapEscrowAbi,
      "0xf5850287af0ca862510157c5cab36241cee76b2b995cdcdc15349df1053ae9b8",
    ],
  ] as const)("%s keeps its topic and the inputs of %s", (legacyName, currentName, abi, topic) => {
    type Input = { name?: string; type: string; indexed?: boolean }
    const shape = (inputs: readonly Input[]) =>
      inputs.map(({ name, type, indexed }) => ({ name, type, indexed: indexed === true }))
    const legacy = getAbiItem({
      abi: LegacySwapEscrowEventsAbi as Abi,
      name: legacyName,
    }) as AbiEvent
    const current = getAbiItem({ abi: abi as Abi, name: currentName }) as AbiEvent
    expect(toEventSelector(legacy)).toBe(topic)
    expect(shape(legacy.inputs)).toEqual(shape(current.inputs))
  })
})
