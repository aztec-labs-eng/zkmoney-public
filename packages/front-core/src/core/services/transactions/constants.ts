// Transaction Service Constants
import {
  TokenActionEnum,
  TransactionStatusEnum,
  QueueStatus,
  OtherActionEnum,
  Network,
} from "@obsidion/sdk"
import { NetworkStorage } from "../../storages"

// Progress values
export const TRANSACTION_PROGRESS = {
  COMPLETE: 100,
  INITIAL: 0,
} as const

export const TOKEN_ACTIONS = {
  // Token actions
  SEND: TokenActionEnum.SEND,
  RECEIVE: TokenActionEnum.RECEIVE,
} as const

export const TRANSACTION_ACTIONS = {
  FAUCET: OtherActionEnum.FAUCET,
  CONTRACT_CALL: OtherActionEnum.CONTRACT_CALL,
} as const

export const TRANSACTION_STATUS = {
  PENDING: TransactionStatusEnum.PENDING,
  SUCCESS: TransactionStatusEnum.SUCCESS,
  FAILED: TransactionStatusEnum.FAILED,
} as const

// Queue status values - using enums
export const QUEUE_STATUS = {
  PENDING: QueueStatus.PENDING,
  SUCCESS: QueueStatus.SUCCESS,
  FAILED: QueueStatus.FAILED,
} as const

// Log prefixes
export const LOG_PREFIX = "[TransactionStorage]" as const

// util method to get estimated time for a transaction: the production estimate
// applies to testnet AND mainnet; only the local sandbox uses the short one.
export const getEstTime = async (time?: number) => {
  const network = await NetworkStorage.get().getNetwork()
  return network.type !== Network.SANDBOX ? time || 180000 : 20000 // 20 secs for sandbox
}
