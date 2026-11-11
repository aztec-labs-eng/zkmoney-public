import { describe, expect, it, vi } from "vitest"
import {
  decodeFunctionData,
  encodeAbiParameters,
  encodeFunctionData,
  erc20Abi,
  pad,
  parseAbi,
  parseAbiParameters,
  zeroAddress,
  type Address,
  type Hex,
} from "viem"
import quoteFixture from "../../fixtures/across/swapApprovalExactOutput.json"
import { AcrossBridgeIn, type AcrossContracts, type TokenDecimals } from "../../../src/core/services/crossChain/acrossBridgeIn"
import type { BridgeInQuoteRequest } from "../../../src/core/services/crossChain/types"
import { WalletError } from "../../../src/engine/errors"

const request: BridgeInQuoteRequest = {
  originChainId: 84532,
  inputToken: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
  destinationChainId: 11155111,
  outputToken: "0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238",
  outputSymbol: "USDC",
  outputAmount: 5_000_000n,
  depositor: "0x000000000000000000000000000000000000dEaD",
  recipient: "0x000000000000000000000000000000000000bEEF",
}
const SPOKE_POOL = quoteFixture.swapTx.to as Address
const PERIPHERY = `0x${"9e".repeat(20)}` as Address
const HANDLER = `0x${"4a".repeat(20)}` as Address
/** The origin chain's listed USDC, which an origin swap must bridge to land USDC. */
const BRIDGED = `0x${"b0".repeat(20)}` as Address
const CONTRACTS: AcrossContracts = {
  origin: new Map([[84532, [SPOKE_POOL, PERIPHERY]]]),
  bridged: new Map([[84532, new Map([["USDC", BRIDGED]])]]),
  multicallHandler: HANDLER,
}
/** Every token has 6 decimals but those `eighteen` names. */
const decimalsOf =
  (eighteen: Address[] = []): TokenDecimals =>
  async (_, token) =>
    eighteen.some((t) => t.toLowerCase() === token.toLowerCase()) ? 18 : 6
const DECIMALS = decimalsOf()
const TX = `0x${"ab".repeat(32)}` as Hex
const FILL = `0x${"cd".repeat(32)}` as Hex

const respond = (status: number, body: unknown) =>
  vi.fn(async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch

describe("AcrossBridgeIn", () => {
  it("asks for an exact output to the deposit address and signs approvals before the bridge", async () => {
    const fetchImpl = respond(200, quoteFixture)
    const quote = await new AcrossBridgeIn("https://across.example/api", CONTRACTS, DECIMALS, fetchImpl).quote(request)

    const url = new URL(vi.mocked(fetchImpl).mock.calls[0][0] as string)
    expect(url.pathname).toBe("/api/swap/approval")
    expect(Object.fromEntries(url.searchParams)).toMatchObject({
      tradeType: "exactOutput",
      amount: "5000000",
      recipient: request.recipient,
      originChainId: "84532",
      destinationChainId: "11155111",
    })
    expect(quote).toMatchObject({ inputAmount: 5_025_000n, outputAmount: 5_000_000n, fee: 25_013n, fillSeconds: 10 })
    expect(quote.expiresAt).toBe(quoteFixture.quoteExpiryTimestamp * 1000)
    expect(quote.txs.map((tx) => tx.to)).toEqual([quoteFixture.approvalTxns[0].to, quoteFixture.swapTx.to])
  })

  it("asks for an exact input and quotes the least that lands", async () => {
    const fetchImpl = respond(200, { ...quoteFixture, minOutputAmount: "4990000" })
    const { outputAmount: _, ...rest } = request
    const quote = await new AcrossBridgeIn("https://a", CONTRACTS, DECIMALS, fetchImpl).quote({
      ...rest,
      inputAmount: 5_025_000n,
    })
    const url = new URL(vi.mocked(fetchImpl).mock.calls[0][0] as string)
    expect(url.searchParams.get("tradeType")).toBe("exactInput")
    expect(url.searchParams.get("amount")).toBe("5025000")
    expect(quote.outputAmount).toBe(4_990_000n)
  })

  it("prices the fee in dollars where Across does, and only as a number", async () => {
    const priced = (amountUsd: unknown) => {
      const body = { ...quoteFixture, fees: { total: { amount: "25013", amountUsd } } }
      return new AcrossBridgeIn("https://a", CONTRACTS, DECIMALS, respond(200, body)).quote(request)
    }
    expect((await priced("0.025")).feeUsd).toBe("0.025")
    expect(await priced("n/a")).not.toHaveProperty("feeUsd")
    expect(await priced("")).not.toHaveProperty("feeUsd")
    const unpriced = await new AcrossBridgeIn("https://a", CONTRACTS, DECIMALS, respond(200, quoteFixture)).quote(request)
    expect(unpriced).not.toHaveProperty("feeUsd")
  })

  it("charges the fee ceiling that matches the least that lands, else the expected fee", async () => {
    const quoted = (fees: unknown) =>
      new AcrossBridgeIn("https://a", CONTRACTS, DECIMALS, respond(200, { ...quoteFixture, fees })).quote(request)
    const total = { amount: "23407", amountUsd: "0.0234" }
    const ceiling = await quoted({ total, totalMax: { amount: "123337", amountUsd: "0.1233" } })
    expect(ceiling).toMatchObject({ fee: 123_337n, feeUsd: "0.1233" })
    expect(await quoted({ total })).toMatchObject({ fee: 23_407n, feeUsd: "0.0234" })
  })

  it("names no expiry when Across returns 0", async () => {
    const body = { ...quoteFixture, quoteExpiryTimestamp: 0 }
    const quote = await new AcrossBridgeIn("https://a", CONTRACTS, DECIMALS, respond(200, body)).quote(request)
    expect(quote.expiresAt).toBeUndefined()
  })

  it("approves only what the bridge call may pull", async () => {
    const body = { ...quoteFixture, maxInputAmount: "5050000" }
    const quote = await new AcrossBridgeIn("https://a", CONTRACTS, DECIMALS, respond(200, body)).quote(request)
    const { functionName, args } = decodeFunctionData({ abi: erc20Abi, data: quote.txs[0].data })
    expect(functionName).toBe("approve")
    expect(args).toEqual([quoteFixture.swapTx.to, 5_050_000n])
    expect(quote.maxInputAmount).toBe(5_050_000n)
  })

  it("refuses a quote that would land less than asked", async () => {
    const short = { ...quoteFixture, expectedOutputAmount: "4999999" }
    await expect(new AcrossBridgeIn("https://a", CONTRACTS, DECIMALS, respond(200, short)).quote(request)).rejects.toThrow(/short/)
  })

  it.each([
    [404, { error: "DepositNotFoundException" }, undefined],
    [200, { status: "pending" }, { status: "pending" }],
    [200, { status: "slowFillRequested" }, { status: "pending" }],
    [200, { status: "filled", fillTx: FILL }, { status: "filled", fillTxHash: FILL }],
    [200, { status: "refunded", depositRefundTxHash: FILL }, { status: "refunded", refundTxHash: FILL }],
    [200, { status: "expired" }, { status: "expired" }],
  ])("maps a %i %j status", async (code, body, expected) => {
    expect(await new AcrossBridgeIn("https://a", CONTRACTS, DECIMALS, respond(code, body)).status(84532, TX)).toEqual(expected)
  })

  it("reads a deposit by its id, with its origin hash", async () => {
    const fetchImpl = respond(200, { status: "filled", fillTx: FILL, depositTxHash: TX })
    expect(await new AcrossBridgeIn("https://a", CONTRACTS, DECIMALS, fetchImpl).statusById(56, "1271856")).toEqual({
      originTxHash: TX,
      status: { status: "filled", fillTxHash: FILL },
    })
    const url = new URL(vi.mocked(fetchImpl).mock.calls[0][0] as string)
    expect(url.pathname).toBe("/deposit/status")
    expect(Object.fromEntries(url.searchParams)).toEqual({ originChainId: "56", depositId: "1271856" })
  })

  it("knows no deposit Across has not indexed, and fails one with no origin hash", async () => {
    const missing = respond(404, { error: "DepositNotFoundException" })
    expect(await new AcrossBridgeIn("https://a", CONTRACTS, DECIMALS, missing).statusById(56, "1")).toBeUndefined()
    const bare = respond(200, { status: "pending" })
    await expect(new AcrossBridgeIn("https://a", CONTRACTS, DECIMALS, bare).statusById(56, "1")).rejects.toThrow()
  })
})

describe("AcrossBridgeIn quote refusals", () => {
  const codeOf = (fetchImpl: typeof fetch) =>
    new AcrossBridgeIn("https://a", CONTRACTS, DECIMALS, fetchImpl).quote(request).then(
      () => undefined,
      (e: unknown) => (e instanceof WalletError ? e.code : e),
    )

  it("names an amount under the fees by Across's code, and any other failure a failed quote", async () => {
    const tooLow = {
      type: "AcrossApiError",
      code: "AMOUNT_TOO_LOW",
      status: 400,
      message: "Failed to fetch swap quote: Bridge amount 1000 is too low to cover bridge fees 39556",
    }
    expect(await codeOf(respond(400, tooLow))).toBe("bridge.belowFee")
    expect(await codeOf(respond(500, { code: "UPSTREAM_HTTP_ERROR" }))).toBe("bridge.quoteFailed")
    const down = vi.fn(async () => Promise.reject(new TypeError("fetch failed")))
    expect(await codeOf(down as unknown as typeof fetch)).toBe("bridge.quoteFailed")
  })
})

/** Across's contracts as the wallet's counterparty: the calls a quote's bridge transaction makes. */
const ACROSS = parseAbi([
  "function deposit(bytes32 depositor, bytes32 recipient, bytes32 inputToken, bytes32 outputToken, uint256 inputAmount, uint256 outputAmount, uint256 destinationChainId, bytes32 exclusiveRelayer, uint32 quoteTimestamp, uint32 fillDeadline, uint32 exclusivityParameter, bytes message)",
  "function depositNative(address spokePool, address depositor, bytes32 recipient, address inputToken, uint256 inputAmount, bytes32 outputToken, uint256 outputAmount, uint256 destinationChainId, bytes32 exclusiveRelayer, uint32 quoteTimestamp, uint32 fillDeadline, uint32 exclusivityParameter, bytes message)",
  "struct Fees { uint256 amount; address recipient; }",
  "struct BaseDepositData { address inputToken; bytes32 outputToken; uint256 outputAmount; address depositor; bytes32 recipient; uint256 destinationChainId; bytes32 exclusiveRelayer; uint32 quoteTimestamp; uint32 fillDeadline; uint32 exclusivityParameter; bytes message; }",
  "struct SwapAndDepositData { Fees submissionFees; BaseDepositData depositData; address swapToken; address exchange; uint8 transferType; uint256 swapTokenAmount; uint256 minExpectedInputTokenAmount; bytes routerCalldata; bool enableProportionalAdjustment; address spokePool; uint256 nonce; }",
  "function swapAndBridge(SwapAndDepositData swapAndDepositData)",
])

describe("AcrossBridgeIn quote checks", () => {
  const OTHER = `0x${"66".repeat(20)}` as Address
  const WETH = "0x4200000000000000000000000000000000000006" as Address
  const word = (a: Address) => pad(a, { size: 32 })

  interface Deposit {
    depositor: Address
    recipient: Address
    inputToken: Address
    outputToken: Address
    inputAmount: bigint
    outputAmount: bigint
    destinationChainId: bigint
    message: Hex
  }
  const plain: Deposit = {
    depositor: request.depositor,
    recipient: request.recipient,
    inputToken: request.inputToken,
    outputToken: request.outputToken,
    inputAmount: 5_025_000n,
    outputAmount: 5_000_000n,
    destinationChainId: 11155111n,
    message: "0x",
  }
  const deposit = (d: Deposit) =>
    encodeFunctionData({
      abi: ACROSS,
      functionName: "deposit",
      args: [
        word(d.depositor),
        word(d.recipient),
        word(d.inputToken),
        word(d.outputToken),
        d.inputAmount,
        d.outputAmount,
        d.destinationChainId,
        pad("0x00", { size: 32 }),
        1,
        2,
        0,
        d.message,
      ],
    })
  const withCall = (data: Hex, swapTx: object = {}) => ({
    ...quoteFixture,
    swapTx: { ...quoteFixture.swapTx, data, ...swapTx },
  })
  const swapAndBridge = (
    o: {
      fee?: bigint
      spokePool?: Address
      minOut?: bigint
      bridged?: Address
      recipient?: Address
      message?: Hex
    } = {},
  ) =>
    encodeFunctionData({
      abi: ACROSS,
      functionName: "swapAndBridge",
      args: [
        {
          submissionFees: { amount: o.fee ?? 0n, recipient: zeroAddress },
          depositData: {
            inputToken: o.bridged ?? BRIDGED,
            outputToken: word(request.outputToken),
            outputAmount: 5_000_000n,
            depositor: request.depositor,
            recipient: word(o.recipient ?? request.recipient),
            destinationChainId: 11155111n,
            exclusiveRelayer: pad("0x00", { size: 32 }),
            quoteTimestamp: 1,
            fillDeadline: 2,
            exclusivityParameter: 0,
            message: o.message ?? "0x",
          },
          swapToken: request.inputToken,
          exchange: `0x${"e0".repeat(20)}`,
          transferType: 0,
          swapTokenAmount: 5_025_000n,
          minExpectedInputTokenAmount: o.minOut ?? 5_000_000n,
          routerCalldata: "0x",
          enableProportionalAdjustment: true,
          spokePool: o.spokePool ?? SPOKE_POOL,
          nonce: 0n,
        },
      ],
    })
  const periphery = (data: Hex) => ({
    ...withCall(data, { to: PERIPHERY }),
    approvalTxns: [
      {
        ...quoteFixture.approvalTxns[0],
        data: encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [PERIPHERY, 1n] }),
      },
    ],
  })

  const nativeRequest: BridgeInQuoteRequest = { ...request, inputToken: zeroAddress }
  const native = (o: { value?: string; message?: Hex } = {}) => ({
    ...quoteFixture,
    maxInputAmount: "5030000",
    approvalTxns: [],
    swapTx: {
      ...quoteFixture.swapTx,
      to: PERIPHERY,
      value: o.value ?? "5030000",
      data: encodeFunctionData({
        abi: ACROSS,
        functionName: "depositNative",
        args: [
          SPOKE_POOL,
          request.depositor,
          word(request.recipient),
          WETH,
          5_025_000n,
          word(request.outputToken),
          5_000_000n,
          11155111n,
          pad("0x00", { size: 32 }),
          1,
          2,
          0,
          o.message ?? "0x",
        ],
      }),
    },
  })

  const quoted = (body: unknown, contracts = CONTRACTS, req = request, decimals = DECIMALS) =>
    new AcrossBridgeIn("https://a", contracts, decimals, respond(200, body)).quote(req)
  const checkOf = (body: unknown, contracts = CONTRACTS, req = request, decimals = DECIMALS) =>
    quoted(body, contracts, req, decimals).then(
      () => undefined,
      (e: unknown) =>
        e instanceof WalletError && e.code === "bridge.quoteFailed" ? e.data?.check : e,
    )

  /** The bridged token at 18 decimals: an origin swap's minimum of 5 lands 5 of a 6-decimal token. */
  const BRIDGED_18 = decimalsOf([BRIDGED])
  const FIVE_18 = 5n * 10n ** 18n

  it.each<[string, unknown, BridgeInQuoteRequest?, TokenDecimals?]>([
    ["a SpokePool deposit to the recipient", quoteFixture],
    ["an origin swap whose minimum covers what lands", periphery(swapAndBridge())],
    [
      "an origin swap from an 18-decimal bridged token to a 6-decimal landing",
      periphery(swapAndBridge({ minOut: FIVE_18 })),
      request,
      BRIDGED_18,
    ],
    ["a native deposit worth the most it may pull", native(), nativeRequest],
  ])("passes %s", async (_, body, req = request, decimals = DECIMALS) => {
    await expect(quoted(body, CONTRACTS, req, decimals)).resolves.toBeDefined()
  })

  const approval = (to: string, data: Hex) => ({
    ...quoteFixture,
    approvalTxns: [{ ...quoteFixture.approvalTxns[0], to, data }],
  })
  const approve = (spender: Address) =>
    encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [spender, 1n] })

  it.each<[string, string, unknown, AcrossContracts?, BridgeInQuoteRequest?, TokenDecimals?]>([
    ["a call on another chain", "chain", { ...quoteFixture, swapTx: { ...quoteFixture.swapTx, chainId: 1 } }],
    ["a chain with no listed contracts", "target", quoteFixture, { ...CONTRACTS, origin: new Map() }],
    ["an unlisted bridge call", "target", withCall(quoteFixture.swapTx.data as Hex, { to: OTHER })],
    ["an approval of another token", "approval", approval(OTHER, approve(SPOKE_POOL))],
    ["an approval to another spender", "approval", approval(request.inputToken, approve(OTHER))],
    [
      "a transfer as an approval",
      "approval",
      approval(request.inputToken, encodeFunctionData({ abi: erc20Abi, functionName: "transfer", args: [OTHER, 1n] })),
    ],
    ["value on a token deposit", "value", withCall(quoteFixture.swapTx.data as Hex, { value: "1" })],
    ["a native deposit short of the most it may pull", "value", native({ value: "5025000" }), CONTRACTS, nativeRequest],
    ["a call that is not a deposit", "call", withCall(approve(OTHER))],
    ["a refund to someone else", "depositor", withCall(deposit({ ...plain, depositor: OTHER }))],
    ["another destination", "destination", withCall(deposit({ ...plain, destinationChainId: 1n }))],
    ["more than it may pull", "amount", withCall(deposit({ ...plain, inputAmount: 5_025_001n }))],
    ["less than quoted", "amount", withCall(deposit({ ...plain, inputAmount: 5_024_999n }))],
    ["another input token", "inputToken", withCall(deposit({ ...plain, inputToken: OTHER }))],
    ["another recipient", "recipient", withCall(deposit({ ...plain, recipient: OTHER }))],
    ["another output token", "outputToken", withCall(deposit({ ...plain, outputToken: OTHER }))],
    ["a fill short of what lands", "outputAmount", withCall(deposit({ ...plain, outputAmount: 4_999_999n }))],
    ["a message to the recipient itself", "recipient", withCall(deposit({ ...plain, message: "0x1234" }))],
    ["a native deposit with a message to the recipient", "recipient", native({ message: "0x1234" }), CONTRACTS, nativeRequest],
    ["a swap into an unlisted SpokePool", "target", periphery(swapAndBridge({ spokePool: OTHER }))],
    ["a swap that charges a submission fee", "fee", periphery(swapAndBridge({ fee: 1n }))],
    ["a swap that may return less than lands", "minSwapOut", periphery(swapAndBridge({ minOut: 4_999_999n }))],
    [
      "a swap whose 18-decimal minimum scales to less than lands",
      "minSwapOut",
      periphery(swapAndBridge({ minOut: FIVE_18 - 1n })),
      CONTRACTS,
      request,
      BRIDGED_18,
    ],
    [
      "a swap that bridges an unlisted token, even of the landing's decimals",
      "bridgedToken",
      periphery(swapAndBridge({ bridged: OTHER })),
    ],
    [
      "a swap landing a symbol the origin chain does not list",
      "bridgedToken",
      periphery(swapAndBridge()),
      CONTRACTS,
      { ...request, outputSymbol: "USDT" },
    ],
  ])("refuses %s", async (_, check, body, contracts = CONTRACTS, req = request, decimals = DECIMALS) => {
    expect(await checkOf(body, contracts, req, decimals)).toBe(check)
  })

  describe("a deposit through the multicall handler", () => {
    const METADATA = `0x${"bf".repeat(20)}` as Address
    const ACROSS_FEES = `0x${"ac".repeat(20)}` as Address
    const HANDLER_ABI = parseAbi([
      "function drainLeftoverTokens(address token, address destination)",
      "function makeCallWithBalance(address target, bytes callData, uint256 value, (address token, uint256 offset)[] replacement)",
      "function emitData(bytes data)",
    ])
    type Call = { target: Address; callData: Hex; value: bigint }
    const drain = (token: Address, to: Address): Call => ({
      target: HANDLER,
      callData: encodeFunctionData({ abi: HANDLER_ABI, functionName: "drainLeftoverTokens", args: [token, to] }),
      value: 0n,
    })
    const onToken = (data: Hex, token = request.outputToken): Call => ({ target: token, callData: data, value: 0n })
    const emit: Call = {
      target: METADATA,
      callData: encodeFunctionData({ abi: HANDLER_ABI, functionName: "emitData", args: ["0x1234"] }),
      value: 0n,
    }
    const message = (calls: Call[], fallbackRecipient: Address = zeroAddress) =>
      encodeAbiParameters(
        parseAbiParameters("((address target, bytes callData, uint256 value)[] calls, address fallbackRecipient)"),
        [{ calls, fallbackRecipient }],
      )
    /** Across's exact-input shape: the landing drained to the recipient twice, two metadata calls. */
    const live = [drain(request.outputToken, request.recipient), drain(request.outputToken, request.recipient), emit, emit]
    const viaHandler = (calls: Call[], o: { fallback?: Address; recipient?: Address } = {}) =>
      periphery(swapAndBridge({ recipient: o.recipient ?? HANDLER, message: message(calls, o.fallback) }))

    it.each<[string, unknown]>([
      ["Across's exact-input message", viaHandler(live)],
      ["a transfer of the landing to the recipient before the drain", viaHandler([onToken(encodeFunctionData({ abi: erc20Abi, functionName: "transfer", args: [request.recipient, 1n] })), ...live])],
      ["a drain of another token to anyone", viaHandler([...live, drain(OTHER, ACROSS_FEES)])],
      ["a fallback to the recipient", viaHandler(live, { fallback: request.recipient })],
      ["a message on a SpokePool deposit", withCall(deposit({ ...plain, recipient: HANDLER, message: message(live) }))],
    ])("passes %s", async (_, body) => {
      await expect(quoted(body)).resolves.toBeDefined()
    })

    it.each<[string, string, unknown, AcrossContracts?]>([
      [
        "Across's exact-output message, which drains the surplus to Across",
        "message",
        viaHandler([
          onToken(encodeFunctionData({ abi: erc20Abi, functionName: "transfer", args: [request.recipient, 5_000_000n] })),
          drain(request.outputToken, ACROSS_FEES),
          emit,
        ]),
      ],
      ["a message that only emits data", "message", viaHandler([emit, emit])],
      [
        "a transfer to the recipient with no drain",
        "message",
        viaHandler([onToken(encodeFunctionData({ abi: erc20Abi, functionName: "transfer", args: [request.recipient, 1n] })), emit]),
      ],
      ["a drain of another token only", "message", viaHandler([drain(OTHER, request.recipient), emit])],
      [
        "a transfer of the landing elsewhere",
        "message",
        viaHandler([onToken(encodeFunctionData({ abi: erc20Abi, functionName: "transfer", args: [OTHER, 1n] })), ...live]),
      ],
      [
        "an approval of the landing",
        "message",
        viaHandler([onToken(encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [OTHER, 1n] })), ...live]),
      ],
      ["a drain of the landing elsewhere", "message", viaHandler([...live, drain(request.outputToken, OTHER)])],
      [
        "a handler call that spends its balance",
        "message",
        viaHandler([
          {
            target: HANDLER,
            callData: encodeFunctionData({
              abi: HANDLER_ABI,
              functionName: "makeCallWithBalance",
              args: [OTHER, "0x", 0n, [{ token: request.outputToken, offset: 0n }]],
            }),
            value: 0n,
          },
          ...live,
        ]),
      ],
      ["a fallback to someone else", "message", viaHandler(live, { fallback: OTHER })],
      ["a call that carries value", "message", viaHandler([...live, { ...emit, value: 1n }])],
      ["a message paid to another contract", "recipient", viaHandler(live, { recipient: OTHER })],
      ["a message with no handler in the profile", "recipient", viaHandler(live), { ...CONTRACTS, multicallHandler: undefined }],
      ["a message that does not decode", "message", periphery(swapAndBridge({ recipient: HANDLER, message: "0x1234" }))],
    ])("refuses %s", async (_, check, body, contracts = CONTRACTS) => {
      expect(await checkOf(body, contracts)).toBe(check)
    })
  })

  it("fails a quote whose swap's decimals do not read", async () => {
    const unread: TokenDecimals = () => Promise.reject(new Error("rpc down"))
    await expect(quoted(periphery(swapAndBridge()), CONTRACTS, request, unread)).rejects.toMatchObject({
      code: "bridge.quoteFailed",
    })
  })
})
