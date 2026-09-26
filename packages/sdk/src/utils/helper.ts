import { Account } from "@aztec/aztec.js/account"
import { TxReceipt } from "@aztec/stdlib/tx"
import { getSponsoredFeePaymentMethod } from "../feePaymentMethod/index.js"
import type { FeeJuiceContract } from "@aztec/noir-contracts.js/FeeJuice"
import { Fr } from "@aztec/aztec.js/fields"
import { ObsidionWallet } from "../obsidion/ObsidionWallet.js"
import { SendInteractionOptions, TxSendResultMined } from "@aztec/aztec.js/contracts"
import { sha256 } from "@aztec/foundation/crypto/sha256"
import type { FeePaymentMethod } from "@aztec/aztec.js/fee"
import { Gas, GasFees, GasSettings } from "@aztec/stdlib/gas"
import type { AztecNode } from "@aztec/aztec.js/node"
import { isL1ToL2MessageReady, waitForL1ToL2MessageReady } from "@aztec/aztec.js/messaging"
import { createAztecNodeAdminClient } from "@aztec/stdlib/interfaces/client"

/**
 * The fee a new tx must actually cover to be admitted. `getCurrentMinFees` is only the
 * fee floor; under accumulated excess mana the block base fee sits well above it, and the
 * sequencer drops any tx priced below the base fee at inclusion (surfacing as "Tx dropped by
 * P2P node" / "Insufficient fee per gas"). Returns max(floor, latest block base fee) per
 * dimension so callers price against reality, not the floor.
 */
export async function getBlockBaseMaxFees(node: AztecNode): Promise<GasFees> {
  const minFees = await node.getCurrentMinFees()
  const blockFees = (await node.getBlockData("latest"))?.header.globalVariables.gasFees
  if (!blockFees) return minFees
  return new GasFees(
    minFees.feePerDaGas > blockFees.feePerDaGas ? minFees.feePerDaGas : blockFees.feePerDaGas,
    minFees.feePerL2Gas > blockFees.feePerL2Gas ? minFees.feePerL2Gas : blockFees.feePerL2Gas,
  )
}

/**
 * Helper method to create an async transaction with immediate hash and delayed completion.
 *
 * @param initFn Function that initializes and sends the transaction
 * @param waitFn Function that processes the transaction result after waiting
 * @returns Object with txPromise, txHash, and sentTx promises
 */
export const createAsyncTransaction = <T, R>(
  initFn: () => Promise<T & { txHash: string }>,
  waitFn: (result: T & { txHash: string }) => Promise<R>,
): {
  txPromise: Promise<R>
  txHash: Promise<string>
  sentTx: Promise<T & { txHash: string }>
} => {
  // Execute initialization once and store result
  const initPromise = initFn()

  // Chain the promises for the full result
  const promiseChain = initPromise.then(waitFn)

  // Create txHash promise from initPromise
  const txHashPromise = initPromise.then((result) => result.txHash)

  // Mark txHash as handled to prevent unhandled rejection warnings
  // when initPromise fails - the error will still be propagated through txPromise
  txHashPromise.catch(() => {})

  // `sentTx` exposes the full send-time result.
  const sentTxPromise = initPromise.then((result) => result)
  sentTxPromise.catch(() => {})

  // Return the three promises
  return {
    txPromise: promiseChain,
    txHash: txHashPromise,
    sentTx: sentTxPromise,
  }
}

// Example: ciphertext: Fr[]
export function frArrayToBase64(ciphertext: Fr[]): string {
  const bytes = Buffer.concat(
    ciphertext.map(
      (fr) => Buffer.from(fr.toBuffer()), // Aztec Fr is already 32 bytes BE
    ),
  )
  return bytes.toString("base64")
}

export function base64ToFrArray(base64: string): Fr[] {
  const bytes = Buffer.from(base64, "base64")

  if (bytes.length % 32 !== 0) {
    throw new Error("Invalid ciphertext length")
  }

  const frs: Fr[] = []

  for (let i = 0; i < bytes.length; i += 32) {
    const chunk = bytes.slice(i, i + 32)
    frs.push(Fr.fromBuffer(chunk))
  }

  return frs
}

// Helper function to process a batch of addresses with a given processor function
export const processBatch = async <T, R>(
  batch: T[],
  processor: (item: T) => Promise<R>,
  batchNumber?: number,
): Promise<R[]> => {
  const results = await Promise.all(batch.map(processor))
  if (batchNumber !== undefined) {
    console.log(`Batch ${batchNumber} processing completed`)
  }
  return results
}

export const isValidBool = (response: Fr[][]): boolean => {
  if (
    response.toString() === "0x0000000000000000000000000000000000000000000000000000000000000001"
  ) {
    return true
  } else {
    return false
  }
}

let feeJuiceContract: FeeJuiceContract | undefined

// `null` means intentionally omit an external fee payer and let the account pay
// with its existing fee juice balance.
export type EmptyTxFeePaymentMethod = FeePaymentMethod | null

export const sendEmptyTx = async (
  wallet: ObsidionWallet,
  account: Account,
  feePaymentMethod?: EmptyTxFeePaymentMethod,
): Promise<TxSendResultMined<TxReceipt>> => {
  console.log("sendEmptyTx...")

  if (!feeJuiceContract) {
    // Lazy: keeps the ~1MB FeeJuice artifact out of the entry chunk.
    const { FeeJuiceContract } = await import("@aztec/noir-contracts.js/FeeJuice")
    const feeJuiceAddr = (await wallet.node.getNodeInfo()).protocolContractAddresses.feeJuice
    feeJuiceContract = FeeJuiceContract.at(feeJuiceAddr, wallet)
  }

  const sendOptions: SendInteractionOptions = {
    from: account.getAddress(),
  }

  const { txsLimits } = await wallet.node.getNodeInfo()
  const gasSettings = GasSettings.fallback({
    maxFeesPerGas: await getBlockBaseMaxFees(wallet.node),
    gasLimits: Gas.from(txsLimits.gas),
  })

  if (feePaymentMethod === null) {
    sendOptions.fee = { gasSettings }
  } else {
    const paymentMethod = feePaymentMethod ?? (await getSponsoredFeePaymentMethod(wallet.pxe))
    sendOptions.fee = {
      paymentMethod,
      gasSettings: paymentMethod.getGasSettings() ?? gasSettings,
    }
  }

  return await feeJuiceContract.methods.check_balance(0n).send(sendOptions)
}

export const sendEmptyTxs = async (
  wallet: ObsidionWallet,
  account: Account,
  count: number,
  feePaymentMethod?: EmptyTxFeePaymentMethod,
) => {
  for (let i = 0; i < count; i++) {
    const currentBlock = await wallet.node.getBlockNumber()
    await sendEmptyTx(wallet, account, feePaymentMethod)

    // Wait for block to increment
    while (true) {
      await new Promise((resolve) => setTimeout(resolve, 500)) // Wait 0.5 seconds
      const newBlock = await wallet.node.getBlockNumber()
      if (newBlock > currentBlock) {
        break
      }
    }
  }
}

/**
 * Sandbox-only: advance blocks until an L1→L2 inbox message is consumable.
 *
 * Fast path: flip the sequencer to `minTxsPerBlock: 0` via the node admin RPC so empty blocks
 * tick for free (no client-side proving), then restore. Auth: set `AZTEC_ADMIN_API_KEY`, or start
 * the sandbox with `AZTEC_DISABLE_ADMIN_API_KEY=1`. When the admin RPC is unreachable or
 * unauthorized, falls back to driving blocks with fully-proven empty txs (slow: one proof each).
 */
export async function waitForSandboxL1ToL2Message(
  wallet: ObsidionWallet,
  account: Account,
  messageHash: Fr,
  options?: {
    timeoutSeconds?: number
    feePaymentMethod?: EmptyTxFeePaymentMethod
    adminUrl?: string
  },
): Promise<void> {
  const timeoutSeconds = options?.timeoutSeconds ?? 300

  const admin = createAztecNodeAdminClient(
    options?.adminUrl ?? process.env.AZTEC_NODE_ADMIN_URL ?? "http://localhost:8880",
    undefined,
    undefined,
    process.env.AZTEC_ADMIN_API_KEY,
  )
  let prevMinTxsPerBlock: number | undefined
  try {
    prevMinTxsPerBlock = (await admin.getConfig()).minTxsPerBlock
    await admin.setConfig({ minTxsPerBlock: 0 })
  } catch {
    const deadline = Date.now() + timeoutSeconds * 1000
    while (!(await isL1ToL2MessageReady(wallet.node as never, messageHash as never))) {
      if (Date.now() > deadline) break
      await sendEmptyTxs(wallet, account, 1, options?.feePaymentMethod)
    }
    await waitForL1ToL2MessageReady(wallet.node as never, messageHash as never, { timeoutSeconds })
    return
  }
  try {
    await waitForL1ToL2MessageReady(wallet.node as never, messageHash as never, { timeoutSeconds })
  } finally {
    await admin.setConfig({ minTxsPerBlock: prevMinTxsPerBlock ?? 1 }).catch(() => {})
  }
}

/**
 * Retry a transaction wait operation multiple times with configurable options
 * @param fn The function to retry that returns a promise
 * @param options Configuration options including number of retries, delay between retries, etc.
 * @returns The result of the successful function call or undefined if all retries fail
 */
export const retryTransactionWait = async <T>(
  fn: () => Promise<T>,
  options: {
    maxRetries?: number
    delayMs?: number
    onError?: (error: any, attempt: number) => void
    onRetry?: (attempt: number) => void
  } = {},
): Promise<T | undefined> => {
  const {
    maxRetries = 10,
    delayMs = 1000,
    onError = (error, attempt) => console.log(`Attempt ${attempt} failed:`, error),
    onRetry = (attempt) => console.log(`Retrying... Attempt ${attempt + 1}/${maxRetries}`),
  } = options

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      return await fn()
    } catch (error) {
      onError(error, attempt + 1)

      if (attempt < maxRetries - 1) {
        onRetry(attempt)
        if (delayMs > 0) {
          await new Promise((resolve) => setTimeout(resolve, delayMs))
        }
      }
    }
  }

  return undefined
}

// Checks `window`, not `process`: browser bundles polyfill `process`.
export const isNodeJS = () => typeof window === "undefined"

/**
 * Hash encrypted data and truncate to 112 bits (14 bytes)
 * @param encryptedData - Encrypted data to hash
 * @returns Truncated hash as hex string
 */
export function hashAndTruncate(encryptedData: Buffer): string {
  const hash = sha256(encryptedData)
  // Truncate to 112 bits (14 bytes)
  const truncated = hash.subarray(0, 14)
  return truncated.toString("hex")
}

/** The L2 anchor day the FPC checks freshness against — chain time, never the browser clock. */
export async function chainEpochDay(wallet: ObsidionWallet): Promise<number> {
  const block = await wallet.node.getBlock("latest" as never)
  if (!block) throw new Error("no L2 block — is the node running?")
  return epochDay(block.header.globalVariables.timestamp)
}

/** Days since epoch — the circuit's u32 `day`. Feed it the chain's anchor timestamp, not wall clock.
 * Shared by the paylink and SIPA services.
 */
export function epochDay(timestampSeconds: number | bigint): number {
  return Number(BigInt(timestampSeconds) / 86400n)
}
