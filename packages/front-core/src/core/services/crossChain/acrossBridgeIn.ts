import {
  decodeAbiParameters,
  decodeFunctionData,
  encodeFunctionData,
  erc20Abi,
  isAddressEqual,
  parseAbi,
  parseAbiParameters,
  size,
  slice,
  zeroAddress,
  type Address,
  type Hex,
} from "viem"
import { WalletError } from "../../../engine/errors"
import type {
  BridgeInDeposit,
  BridgeInDepositLookup,
  BridgeInProvider,
  BridgeInQuote,
  BridgeInQuoteRequest,
  BridgeInStatus,
  BridgeTx,
} from "./types"

const TIMEOUT_MS = 10_000

interface AcrossTx {
  chainId: number
  to: Address
  data: Hex
  value?: string
}

interface AcrossFee {
  amount: string
  amountUsd?: string
}

interface AcrossSwapApproval {
  inputAmount: string
  /** What the bridge call may pull, slippage included. */
  maxInputAmount?: string
  expectedOutputAmount: string
  minOutputAmount?: string
  /** In the input token. `total` nets the expected swap impact; `totalMax` matches the min output. */
  fees: { total: AcrossFee; totalMax?: AcrossFee }
  expectedFillTime: number
  quoteExpiryTimestamp: number
  approvalTxns?: AcrossTx[]
  swapTx: AcrossTx
  /** The bridge leg; shown only, never checked. */
  steps?: { bridge?: { inputAmount?: string; tokenIn?: { symbol?: string } } }
}

interface AcrossDepositStatus {
  status: "pending" | "slowFillRequested" | "filled" | "expired" | "refunded"
  depositTxHash?: Hex | null
  fillTx?: Hex | null
  depositRefundTxHash?: Hex | null
}

const tx = ({ chainId, to, data, value }: AcrossTx): BridgeTx => ({
  chainId,
  to,
  data,
  ...(value && value !== "0" ? { value: BigInt(value) } : {}),
})

function statusOf(body: AcrossDepositStatus): BridgeInStatus {
  switch (body.status) {
    case "filled":
      if (!body.fillTx)
        throw new WalletError("invariant", "Across reports a fill with no transaction")
      return { status: "filled", fillTxHash: body.fillTx }
    case "refunded":
      return {
        status: "refunded",
        ...(body.depositRefundTxHash ? { refundTxHash: body.depositRefundTxHash } : {}),
      }
    case "expired":
      return { status: "expired" }
    default:
      return { status: "pending" }
  }
}

/** The Across contracts a quote's calls may name, from the trusted profile. */
export interface AcrossContracts {
  /**
   * Per origin chain: the SpokePool and the periphery. A chain with none quotes nothing. Exchanges
   * are not listed: in `swapAndBridge` the periphery hands the swap amount to its own SwapProxy,
   * which alone calls the exchange, and the deposit's parties come from `depositData`. So an
   * exchange never holds the approval and cannot redirect funds; `checkMinSwapOut` bounds its loss.
   */
  origin: ReadonlyMap<number, readonly Address[]>
  /** Per origin chain, each listed token by symbol: what an origin swap must bridge to land it. */
  bridged: ReadonlyMap<number, ReadonlyMap<string, Address>>
  /** The L1 MulticallHandler a deposit with a message pays. Without it no such deposit quotes. */
  multicallHandler?: Address
}

/** A token's ERC-20 decimals on a chain, read from the profile's RPCs. */
export type TokenDecimals = (chainId: number, token: Address) => Promise<number>

/** The SpokePool's deposits and the periphery's native deposit and origin swap. */
const ACROSS_ABI = parseAbi([
  "function deposit(bytes32 depositor, bytes32 recipient, bytes32 inputToken, bytes32 outputToken, uint256 inputAmount, uint256 outputAmount, uint256 destinationChainId, bytes32 exclusiveRelayer, uint32 quoteTimestamp, uint32 fillDeadline, uint32 exclusivityParameter, bytes message)",
  "function depositV3(address depositor, address recipient, address inputToken, address outputToken, uint256 inputAmount, uint256 outputAmount, uint256 destinationChainId, address exclusiveRelayer, uint32 quoteTimestamp, uint32 fillDeadline, uint32 exclusivityParameter, bytes message)",
  "function depositNative(address spokePool, address depositor, bytes32 recipient, address inputToken, uint256 inputAmount, bytes32 outputToken, uint256 outputAmount, uint256 destinationChainId, bytes32 exclusiveRelayer, uint32 quoteTimestamp, uint32 fillDeadline, uint32 exclusivityParameter, bytes message)",
  "struct Fees { uint256 amount; address recipient; }",
  "struct BaseDepositData { address inputToken; bytes32 outputToken; uint256 outputAmount; address depositor; bytes32 recipient; uint256 destinationChainId; bytes32 exclusiveRelayer; uint32 quoteTimestamp; uint32 fillDeadline; uint32 exclusivityParameter; bytes message; }",
  "struct SwapAndDepositData { Fees submissionFees; BaseDepositData depositData; address swapToken; address exchange; uint8 transferType; uint256 swapTokenAmount; uint256 minExpectedInputTokenAmount; bytes routerCalldata; bool enableProportionalAdjustment; address spokePool; uint256 nonce; }",
  "function swapAndBridge(SwapAndDepositData swapAndDepositData)",
])

/** The MulticallHandler's message: the calls it makes with what the fill pays it. */
const INSTRUCTIONS = parseAbiParameters(
  "((address target, bytes callData, uint256 value)[] calls, address fallbackRecipient)",
)
/** The handler's one call a message may make on it, and the output token's one call. */
const MESSAGE_ABI = parseAbi([
  "function drainLeftoverTokens(address token, address destination)",
  "function transfer(address to, uint256 amount)",
])

/** A bridge call read as the deposit it makes; `swap` is set for an origin swap. */
interface AcrossDeposit {
  spokePool: Address
  depositor: Hex
  recipient: Hex
  /** The token the call takes; undefined for a native deposit, which takes `wrapped`. */
  inputToken?: Hex
  wrapped?: Address
  outputToken: Hex
  amount: bigint
  outputAmount: bigint
  destinationChainId: bigint
  message: Hex
  /** `minOut` is in `bridged`, the token the swap returns and the deposit bridges. */
  swap?: { minOut: bigint; bridged: Address; submissionFee: bigint }
}

function refuse(check: string, detail: string, cause?: unknown): never {
  throw new WalletError("bridge.quoteFailed", `Across quote ${detail}`, {
    data: { check },
    ...(cause !== undefined && { cause }),
  })
}

/** Decodes untrusted calldata, refusing it under `check` if it does not decode. */
function decoded<T>(check: string, read: () => T): T {
  try {
    return read()
  } catch (e) {
    if (e instanceof WalletError) throw e
    return refuse(check, "sent calldata that does not decode", e)
  }
}

/** A 20-byte address or a bytes32 that holds one, compared without case. */
function names(word: Hex, address: Address): boolean {
  if (size(word) === 32 && BigInt(slice(word, 0, 12)) !== 0n) return false
  return isAddressEqual(size(word) === 32 ? slice(word, 12) : word, address)
}

function depositOf(call: AcrossTx): AcrossDeposit {
  const { functionName, args } = decoded("call", () =>
    decodeFunctionData({ abi: ACROSS_ABI, data: call.data }),
  )
  switch (functionName) {
    case "deposit":
    case "depositV3": {
      const [depositor, recipient, inputToken, outputToken, amount, outputAmount, chain] = args
      const message = args[11]
      return {
        spokePool: call.to,
        depositor,
        recipient,
        inputToken,
        outputToken,
        amount,
        outputAmount,
        destinationChainId: chain,
        message,
      }
    }
    case "depositNative": {
      const [spokePool, depositor, recipient, wrapped, amount, outputToken, outputAmount, chain] =
        args
      return {
        spokePool,
        depositor,
        recipient,
        wrapped,
        outputToken,
        amount,
        outputAmount,
        destinationChainId: chain,
        message: args[12],
      }
    }
    case "swapAndBridge": {
      const [swapAndDeposit] = args
      const { submissionFees, depositData, swapToken, swapTokenAmount, spokePool } = swapAndDeposit
      return {
        spokePool,
        depositor: depositData.depositor,
        recipient: depositData.recipient,
        inputToken: swapToken,
        outputToken: depositData.outputToken,
        amount: swapTokenAmount,
        outputAmount: depositData.outputAmount,
        destinationChainId: depositData.destinationChainId,
        message: depositData.message,
        swap: {
          minOut: swapAndDeposit.minExpectedInputTokenAmount,
          bridged: depositData.inputToken,
          submissionFee: submissionFees.amount,
        },
      }
    }
  }
}

/**
 * That the deposit lands at least `landing` of the request's output token with the recipient:
 * directly, or through the MulticallHandler and a message that {@link checkMessage} passes.
 */
function checkDelivery(
  deposit: AcrossDeposit,
  request: BridgeInQuoteRequest,
  handler: Address | undefined,
  landing: bigint,
) {
  if (!names(deposit.outputToken, request.outputToken)) refuse("outputToken", "lands another token")
  if (deposit.outputAmount < landing) refuse("outputAmount", "lands less than quoted")
  if (deposit.message === "0x") {
    if (!names(deposit.recipient, request.recipient)) refuse("recipient", "pays someone else")
    return
  }
  if (!handler || !names(deposit.recipient, handler))
    refuse("recipient", "pays an unknown contract")
  checkMessage(deposit.message, request, handler)
}

/**
 * That the handler's calls send the output token to the recipient alone: a drain of it or a
 * transfer of it, each to the recipient, and no other call on the handler or the token. Other
 * calls carry no value, and the handler grants no allowance, so they move nothing it holds. A
 * fallback other than the recipient would take everything should a call fail.
 */
function checkMessage(message: Hex, request: BridgeInQuoteRequest, handler: Address) {
  const { recipient, outputToken } = request
  const [{ calls, fallbackRecipient }] = decoded("message", () =>
    decodeAbiParameters(INSTRUCTIONS, message),
  )
  if (
    !isAddressEqual(fallbackRecipient, zeroAddress) &&
    !isAddressEqual(fallbackRecipient, recipient)
  )
    refuse("message", "falls back to someone else")
  // The handler's entry point takes any caller, so a fill left in it is anyone's: the message must
  // drain the landing to the recipient.
  let drained = false
  for (const { target, callData, value } of calls) {
    if (value !== 0n) refuse("message", "sends value")
    const onHandler = isAddressEqual(target, handler)
    if (!onHandler && !isAddressEqual(target, outputToken)) continue
    const { functionName, args } = decoded("message", () =>
      decodeFunctionData({ abi: MESSAGE_ABI, data: callData }),
    )
    if (onHandler) {
      if (functionName !== "drainLeftoverTokens") refuse("message", "makes another handler call")
      const [token, to] = args
      if (isAddressEqual(token, outputToken)) {
        if (!isAddressEqual(to, recipient)) refuse("message", "drains the landing to someone else")
        drained = true
      }
    } else if (functionName !== "transfer" || !isAddressEqual(args[0], recipient)) {
      refuse("message", "moves the landing to someone else")
    }
  }
  if (!drained) refuse("message", "leaves the landing in the handler")
}

/**
 * That an origin swap bridges the origin chain's listed token of the landing's symbol, and returns
 * no less of it than the deposit lands: its minimum against the deposit's output in the L1 token,
 * each at its own chain's decimals. The periphery reverts below the minimum, so with `outputAmount`
 * checked against the quote, the swap cannot land less than was shown.
 */
async function checkMinSwapOut(
  swap: NonNullable<AcrossDeposit["swap"]>,
  outputAmount: bigint,
  request: BridgeInQuoteRequest,
  contracts: AcrossContracts,
  decimals: TokenDecimals,
) {
  const listed = contracts.bridged.get(request.originChainId)?.get(request.outputSymbol)
  if (!listed || !isAddressEqual(swap.bridged, listed))
    refuse("bridgedToken", "bridges a token the profile does not list for the landing")
  const [bridged, landed] = await Promise.all([
    decimals(request.originChainId, swap.bridged),
    decimals(request.destinationChainId, request.outputToken),
  ]).catch((e: unknown) => {
    throw new WalletError("bridge.quoteFailed", "Across quote's token decimals did not read", {
      cause: e,
    })
  })
  if (swap.minOut * 10n ** BigInt(landed) < outputAmount * 10n ** BigInt(bridged))
    refuse("minSwapOut", "lets its swap return less than lands")
}

/**
 * Refuses a quote whose calls do anything but bridge the request: approvals of the input token to
 * the bridge call alone, a call to a listed Across contract with the value it takes, and a deposit
 * from the depositor, to the destination, of a quoted amount, that pays the recipient. Returns the
 * deposit.
 */
async function checkQuote(
  request: BridgeInQuoteRequest,
  body: AcrossSwapApproval,
  contracts: AcrossContracts,
  landing: bigint,
  decimals: TokenDecimals,
): Promise<AcrossDeposit> {
  const { swapTx } = body
  const listed = contracts.origin.get(request.originChainId) ?? []
  const known = (address: Address) => listed.some((c) => isAddressEqual(c, address))
  const native = isAddressEqual(request.inputToken, zeroAddress)
  const inputAmount = BigInt(body.inputAmount)
  const pull = BigInt(body.maxInputAmount ?? body.inputAmount)

  for (const call of [...(body.approvalTxns ?? []), swapTx])
    if (call.chainId !== request.originChainId) refuse("chain", "calls another chain")
  if (!known(swapTx.to)) refuse("target", "calls an unlisted contract")
  for (const approval of body.approvalTxns ?? []) {
    const { functionName, args } = decoded("approval", () =>
      decodeFunctionData({ abi: erc20Abi, data: approval.data }),
    )
    if (
      functionName !== "approve" ||
      !isAddressEqual(approval.to, request.inputToken) ||
      !isAddressEqual(args[0], swapTx.to) ||
      BigInt(approval.value ?? 0) !== 0n
    )
      refuse("approval", "approves something else")
  }
  if (BigInt(swapTx.value ?? 0) !== (native ? pull : 0n)) refuse("value", "sends the wrong value")

  const deposit = depositOf(swapTx)
  if (!known(deposit.spokePool)) refuse("target", "deposits into an unlisted contract")
  if (deposit.swap && deposit.swap.submissionFee !== 0n) refuse("fee", "charges a submission fee")
  if (!names(deposit.depositor, request.depositor)) refuse("depositor", "refunds someone else")
  if (deposit.destinationChainId !== BigInt(request.destinationChainId))
    refuse("destination", "bridges to another chain")
  if (
    pull < inputAmount ||
    (request.inputAmount !== undefined && inputAmount !== request.inputAmount) ||
    deposit.amount < inputAmount ||
    deposit.amount > pull
  )
    refuse("amount", "deposits an amount it did not quote")
  if (!native && (!deposit.inputToken || !names(deposit.inputToken, request.inputToken)))
    refuse("inputToken", "takes another token")
  checkDelivery(deposit, request, contracts.multicallHandler, landing)
  if (deposit.swap)
    await checkMinSwapOut(deposit.swap, deposit.outputAmount, request, contracts, decimals)
  return deposit
}

/**
 * What a checked deposit bridges, and so what Across refunds, when it is not the request's input:
 * an origin swap's output, at least its minimum, or a native deposit's wrapped token. Named as the
 * profile lists it, else as Across does; undefined when neither names it.
 */
async function bridgedOf(
  deposit: AcrossDeposit,
  body: AcrossSwapApproval,
  request: BridgeInQuoteRequest,
  contracts: AcrossContracts,
  decimals: TokenDecimals,
): Promise<BridgeInQuote["bridged"]> {
  const token = deposit.swap?.bridged ?? deposit.wrapped
  if (!token) return undefined
  const listed = contracts.bridged.get(request.originChainId) ?? new Map<string, Address>()
  const symbol =
    [...listed].find(([, address]) => isAddressEqual(address, token))?.[0] ??
    body.steps?.bridge?.tokenIn?.symbol
  if (!symbol) return undefined
  let amount = deposit.amount
  if (deposit.swap) {
    const expected = body.steps?.bridge?.inputAmount ?? ""
    const swapped = /^\d+$/.test(expected) ? BigInt(expected) : 0n
    amount = swapped > deposit.swap.minOut ? swapped : deposit.swap.minOut
  }
  const places = await decimals(request.originChainId, token).catch((e: unknown) => {
    throw new WalletError("bridge.quoteFailed", "Across quote's bridged decimals did not read", {
      cause: e,
    })
  })
  return { symbol, amount, decimals: places }
}

/** Across's error body. Its amounts are only in `message`, which is never parsed. */
interface AcrossError {
  code?: string
  message?: string
}

/** Across's Swap API. A quote's `outputAmount` is the least the recipient receives. */
export class AcrossBridgeIn implements BridgeInProvider, BridgeInDepositLookup {
  constructor(
    private readonly apiUrl: string,
    private readonly contracts: AcrossContracts,
    private readonly decimals: TokenDecimals,
    private readonly fetchImpl: typeof fetch = (...args) => fetch(...args),
  ) {}

  async quote(request: BridgeInQuoteRequest): Promise<BridgeInQuote> {
    const exactOutput = request.outputAmount !== undefined
    const params = new URLSearchParams({
      tradeType: exactOutput ? "exactOutput" : "exactInput",
      amount: (request.outputAmount ?? request.inputAmount).toString(),
      inputToken: request.inputToken,
      originChainId: String(request.originChainId),
      outputToken: request.outputToken,
      destinationChainId: String(request.destinationChainId),
      depositor: request.depositor,
      recipient: request.recipient,
    })
    const body = (await this.get(`/swap/approval?${params}`, "quote").catch((e: unknown) => {
      if (e instanceof WalletError && e.code === "bridge.belowFee") throw e
      throw new WalletError("bridge.quoteFailed", "Across quote failed", { cause: e })
    })) as AcrossSwapApproval
    const outputAmount = BigInt(body.minOutputAmount ?? body.expectedOutputAmount)
    if (exactOutput && outputAmount < request.outputAmount) {
      throw new WalletError(
        "invariant",
        `Across quoted ${outputAmount}, short of the ${request.outputAmount} asked for`,
      )
    }
    const deposit = await checkQuote(request, body, this.contracts, outputAmount, this.decimals)
    const bridged = await bridgedOf(deposit, body, request, this.contracts, this.decimals)
    const pull = BigInt(body.maxInputAmount ?? body.inputAmount)
    // Across asks for an unlimited allowance; this grants only what the bridge call may pull.
    const approvals = (body.approvalTxns ?? []).map((approval) => ({
      ...approval,
      data: encodeFunctionData({
        abi: erc20Abi,
        functionName: "approve",
        args: [body.swapTx.to, pull],
      }),
    }))
    const fee = body.fees.totalMax ?? body.fees.total
    const usd = fee.amountUsd
    const feeUsd = usd && Number.isFinite(Number(usd)) ? usd : undefined
    return {
      inputAmount: BigInt(body.inputAmount),
      maxInputAmount: pull,
      outputAmount,
      expectedOutputAmount: BigInt(body.expectedOutputAmount),
      fee: BigInt(fee.amount),
      ...(feeUsd !== undefined && { feeUsd }),
      ...(bridged && { bridged }),
      fillSeconds: body.expectedFillTime,
      // Some routes come back with 0.
      ...(body.quoteExpiryTimestamp > 0 && { expiresAt: body.quoteExpiryTimestamp * 1000 }),
      txs: [...approvals, body.swapTx].map(tx),
    }
  }

  async status(originChainId: number, originTxHash: Hex): Promise<BridgeInStatus | undefined> {
    const params = new URLSearchParams({
      originChainId: String(originChainId),
      depositTxHash: originTxHash,
    })
    const body = (await this.get(`/deposit/status?${params}`, "deposit status")) as
      | AcrossDepositStatus
      | undefined
    return body && statusOf(body)
  }

  async statusById(originChainId: number, depositId: string): Promise<BridgeInDeposit | undefined> {
    const params = new URLSearchParams({ originChainId: String(originChainId), depositId })
    const body = (await this.get(`/deposit/status?${params}`, "deposit status")) as
      | AcrossDepositStatus
      | undefined
    if (!body) return undefined
    if (!body.depositTxHash)
      throw new WalletError("invariant", "Across reports a deposit with no origin transaction")
    return { originTxHash: body.depositTxHash, status: statusOf(body) }
  }

  /** `undefined` on 404, which Across answers for a deposit it has not indexed yet. */
  private async get(path: string, name: string): Promise<unknown> {
    const response = await this.fetchImpl(`${this.apiUrl}${path}`, {
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })
    if (response.status === 404 && name === "deposit status") return undefined
    if (!response.ok) {
      const { code, message } = (await response.json().catch(() => ({}))) as AcrossError
      const status = String(response.status)
      throw new WalletError(
        code === "AMOUNT_TOO_LOW" ? "bridge.belowFee" : "unknown",
        `Across ${name} returned ${status}${message ? `: ${message}` : ""}`,
        { data: { status, message: message ?? "" } },
      )
    }
    return response.json()
  }
}
