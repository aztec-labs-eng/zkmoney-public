/**
 * An in-memory L1 node for transactions a wallet sends: each waits in the mempool until it is
 * mined, dropped or replaced at its nonce. It answers the viem reads that follow a sent
 * transaction. `fakeTransferNode.l1.test.ts` holds it to the L1 sim.
 */
import {
  encodeFunctionData,
  erc20Abi,
  pad,
  toHex,
  TransactionNotFoundError,
  TransactionReceiptNotFoundError,
  type Address,
  type Hex,
  type PublicClient,
} from "viem"

/** The reads a sender makes of a transaction it sent. */
export type TransferNodeClient = Pick<
  PublicClient,
  "getTransaction" | "getTransactionCount" | "getTransactionReceipt" | "waitForTransactionReceipt"
>

/** A transaction to send: an ERC-20 transfer when `token` is set, else an empty call to `to`. */
export interface TransferSend {
  from: Address
  to: Address
  token?: Address
  amount?: bigint
  /** Defaults to the sender's next; a pending transaction at this nonce is replaced. */
  nonce?: number
}

interface Tx {
  hash: Hex
  from: Address
  to: Address
  nonce: number
  token?: Address
  amount: bigint
  status?: "success" | "reverted"
  block?: bigint
}

const lower = (a: string) => a.toLowerCase()

export class FakeTransferNode {
  head = 1n
  /** Fails a client read by method name. */
  failing: (method: keyof TransferNodeClient) => boolean = () => false
  /** Every transaction the node knows: pending or mined. */
  private readonly known = new Map<Hex, Tx>()
  private readonly confirmed = new Map<string, number>()
  private readonly balances = new Map<string, bigint>()
  private readonly changed = new Set<() => void>()
  private sent = 0
  readonly client: TransferNodeClient

  constructor() {
    const read = <T>(method: keyof TransferNodeClient, answer: () => T): Promise<T> =>
      this.failing(method)
        ? Promise.reject(new Error(`fake node: ${method} failed`))
        : Promise.resolve().then(answer)
    const client = {
      getTransaction: ({ hash }: { hash: Hex }) =>
        read("getTransaction", () => {
          const tx = this.known.get(hash)
          if (!tx) throw new TransactionNotFoundError({ hash })
          return { ...this.rpc(tx), blockNumber: tx.block ?? null }
        }),
      // The confirmed count: the "latest" tag a sender's check reads.
      getTransactionCount: ({ address }: { address: Address }) =>
        read("getTransactionCount", () => this.confirmedOf(address)),
      getTransactionReceipt: ({ hash }: { hash: Hex }) =>
        read("getTransactionReceipt", () => {
          const tx = this.known.get(hash)
          if (!tx?.status) throw new TransactionReceiptNotFoundError({ hash })
          return this.receipt(tx)
        }),
      waitForTransactionReceipt: (args: {
        hash: Hex
        onReplaced?: (replacement: unknown) => void
      }) => read("waitForTransactionReceipt", () => this.wait(args)),
    }
    this.client = client as unknown as TransferNodeClient
  }

  setBalance(holder: Address, token: Address, amount: bigint): void {
    this.balances.set(`${lower(holder)}:${lower(token)}`, amount)
  }

  balanceOf(holder: Address, token: Address): bigint {
    return this.balances.get(`${lower(holder)}:${lower(token)}`) ?? 0n
  }

  /** Puts a transaction in the mempool; resolves its hash. */
  send(s: TransferSend): Hex {
    const nonce = s.nonce ?? this.nextNonce(s.from)
    for (const tx of this.known.values())
      if (!tx.status && lower(tx.from) === lower(s.from) && tx.nonce === nonce)
        this.known.delete(tx.hash)
    const hash = pad(toHex(++this.sent), { size: 32 })
    this.known.set(hash, { hash, ...s, nonce, amount: s.amount ?? 0n })
    return hash
  }

  /** The node forgets a pending transaction. */
  drop(hash: Hex): void {
    if (!this.known.get(hash)?.status) this.known.delete(hash)
  }

  /** Mines one block of every pending transaction in nonce order. A transfer not covered reverts. */
  mine(): void {
    this.head += 1n
    const pending = [...this.known.values()]
      .filter((tx) => !tx.status)
      .sort((a, b) => a.nonce - b.nonce)
    for (const tx of pending) {
      if (tx.nonce !== this.confirmedOf(tx.from)) continue
      this.confirmed.set(lower(tx.from), tx.nonce + 1)
      tx.block = this.head
      tx.status = "success"
      if (!tx.token) continue
      if (this.balanceOf(tx.from, tx.token) < tx.amount) {
        tx.status = "reverted"
        continue
      }
      this.setBalance(tx.from, tx.token, this.balanceOf(tx.from, tx.token) - tx.amount)
      this.setBalance(tx.to, tx.token, this.balanceOf(tx.to, tx.token) + tx.amount)
    }
    for (const notify of [...this.changed]) notify()
  }

  private confirmedOf(address: Address): number {
    return this.confirmed.get(lower(address)) ?? 0
  }

  private nextNonce(address: Address): number {
    const pending = [...this.known.values()].filter(
      (tx) => !tx.status && lower(tx.from) === lower(address),
    )
    return Math.max(this.confirmedOf(address), ...pending.map((tx) => tx.nonce + 1))
  }

  private rpc(tx: Tx) {
    return {
      hash: tx.hash,
      from: lower(tx.from) as Address,
      to: tx.token ?? tx.to,
      nonce: tx.nonce,
      value: 0n,
      input: tx.token
        ? encodeFunctionData({ abi: erc20Abi, functionName: "transfer", args: [tx.to, tx.amount] })
        : "0x",
    }
  }

  private receipt(tx: Tx) {
    return {
      transactionHash: tx.hash,
      status: tx.status,
      blockNumber: tx.block,
      from: lower(tx.from),
    }
  }

  /**
   * As viem waits: the transaction's own receipt, or, once a transaction of the same sender and
   * nonce mines in its place, that one's, reported to `onReplaced`. A hash the node never knew
   * waits on.
   */
  private wait({ hash, onReplaced }: { hash: Hex; onReplaced?: (replacement: unknown) => void }) {
    const seen = this.known.get(hash)
    return new Promise((resolve) => {
      if (!seen) return
      const check = () => {
        if (seen.status) return finish(() => resolve(this.receipt(seen)))
        const by = [...this.known.values()].find(
          (tx) => tx.status && lower(tx.from) === lower(seen.from) && tx.nonce === seen.nonce,
        )
        if (!by) return
        const [was, now] = [this.rpc(seen), this.rpc(by)]
        const reason = now.to === was.to && now.input === was.input ? "repriced" : "replaced"
        finish(() => {
          onReplaced?.({ reason, replacedTransaction: was, transaction: now })
          resolve(this.receipt(by))
        })
      }
      const finish = (end: () => void) => {
        this.changed.delete(check)
        end()
      }
      this.changed.add(check)
      check()
    })
  }
}
