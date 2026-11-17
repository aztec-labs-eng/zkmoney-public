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
import type { BridgeFill, BridgeFillDetector, ReceiptLog } from "./types"

/** Across's SpokePool fill event. Its `recipient` is the multicall handler, not the deposit address. */
export const FILLED_RELAY = parseAbiItem(
  "event FilledRelay(bytes32 inputToken, bytes32 outputToken, uint256 inputAmount, uint256 outputAmount, uint256 repaymentChainId, uint256 indexed originChainId, uint256 indexed depositId, uint32 fillDeadline, uint32 exclusivityDeadline, bytes32 exclusiveRelayer, bytes32 indexed relayer, bytes32 depositor, bytes32 recipient, bytes32 messageHash, (bytes32 updatedRecipient, bytes32 updatedMessageHash, uint256 updatedOutputAmount, uint8 fillType) relayExecutionInfo)",
)

const FILLED_RELAY_TOPIC = toEventSelector(FILLED_RELAY)
const TRANSFER = erc20Abi.find((item) => item.type === "event" && item.name === "Transfer")!
const TRANSFER_TOPIC = toEventSelector(TRANSFER)

const asAddress = (word: Hex): Address => getAddress(sliceHex(word, 12))

/**
 * Reads Across fills off a receipt: the first token transfer to `recipient` with a `FilledRelay`
 * from one of `spokePools` before it, and the nearest such. Any contract can emit a look-alike.
 */
export const acrossFills =
  (spokePools: readonly Address[]): BridgeFillDetector =>
  (logs: readonly ReceiptLog[], recipient: Address): BridgeFill | undefined => {
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
        .find(
          (l) =>
            l.topics[0] === FILLED_RELAY_TOPIC &&
            l.topics.length === 4 &&
            spokePools.some((pool) => isAddressEqual(l.address, pool)),
        )
      if (!fill) continue
      const { args } = decodeEventLog({
        abi: [FILLED_RELAY],
        eventName: "FilledRelay",
        topics: fill.topics as [Hex, ...Hex[]],
        data: fill.data,
      })
      return {
        provider: "across",
        originChainId: Number(args.originChainId),
        depositId: args.depositId.toString(),
        depositor: asAddress(args.depositor),
        inputToken: asAddress(args.inputToken),
        inputAmount: args.inputAmount,
        deadline: args.fillDeadline * 1000,
        token: log.address,
        value: transfer.args.value,
      }
    }
    return undefined
  }
