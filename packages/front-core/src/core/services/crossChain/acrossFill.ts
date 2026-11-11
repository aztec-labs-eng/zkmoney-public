import {
  decodeEventLog,
  erc20Abi,
  getAddress,
  isAddressEqual,
  parseAbiItem,
  sliceHex,
  toEventSelector,
  type Address,
  type Hex,
} from "viem"

/** Across's SpokePool fill event. Its `recipient` is the multicall handler, not the deposit address. */
export const FILLED_RELAY = parseAbiItem(
  "event FilledRelay(bytes32 inputToken, bytes32 outputToken, uint256 inputAmount, uint256 outputAmount, uint256 repaymentChainId, uint256 indexed originChainId, uint256 indexed depositId, uint32 fillDeadline, uint32 exclusivityDeadline, bytes32 exclusiveRelayer, bytes32 indexed relayer, bytes32 depositor, bytes32 recipient, bytes32 messageHash, (bytes32 updatedRecipient, bytes32 updatedMessageHash, uint256 updatedOutputAmount, uint8 fillType) relayExecutionInfo)",
)

const FILLED_RELAY_TOPIC = toEventSelector(FILLED_RELAY)
const TRANSFER = erc20Abi.find((item) => item.type === "event" && item.name === "Transfer")!
const TRANSFER_TOPIC = toEventSelector(TRANSFER)

/** A receipt log, as viem formats one. */
export interface ReceiptLog {
  address: Address
  topics: readonly Hex[]
  data: Hex
  logIndex: number | null
}

/** A bridge-in Across filled: its deposit on the origin chain, and what the fill paid. */
export interface AcrossFill {
  originChainId: number
  depositId: string
  depositor: Address
  /** On the origin chain; `inputAmount` is in its base units. */
  inputToken: Address
  inputAmount: bigint
  /** The token and base units the deposit address received. */
  token: Address
  value: bigint
}

const asAddress = (word: Hex): Address => getAddress(sliceHex(word, 12))

/**
 * The fill that paid `recipient` in a receipt: the first token transfer to it with a `FilledRelay`
 * before it, and the nearest such. Undefined when no fill pays it.
 */
export function acrossFillIn(
  logs: readonly ReceiptLog[],
  recipient: Address,
): AcrossFill | undefined {
  const ordered = [...logs].sort((a, b) => (a.logIndex ?? 0) - (b.logIndex ?? 0))
  for (const [index, log] of ordered.entries()) {
    if (log.topics[0] !== TRANSFER_TOPIC || log.topics.length !== 3) continue
    const transfer = decodeEventLog({
      abi: [TRANSFER],
      eventName: "Transfer",
      topics: log.topics as [Hex, ...Hex[]],
      data: log.data,
    })
    if (!isAddressEqual(transfer.args.to, recipient)) continue
    const fill = ordered
      .slice(0, index)
      .reverse()
      .find((l) => l.topics[0] === FILLED_RELAY_TOPIC && l.topics.length === 4)
    if (!fill) continue
    const { args } = decodeEventLog({
      abi: [FILLED_RELAY],
      eventName: "FilledRelay",
      topics: fill.topics as [Hex, ...Hex[]],
      data: fill.data,
    })
    return {
      originChainId: Number(args.originChainId),
      depositId: args.depositId.toString(),
      depositor: asAddress(args.depositor),
      inputToken: asAddress(args.inputToken),
      inputAmount: args.inputAmount,
      token: log.address,
      value: transfer.args.value,
    }
  }
  return undefined
}
