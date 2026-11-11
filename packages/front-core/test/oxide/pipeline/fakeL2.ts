/**
 * An in-memory Aztec side for the SIPA pipeline: the `SIPA` events a PXE reads, the L1→L2 messages a
 * node holds, the deposits spent, and the claims a token service runs. The consumed-deposit lookup
 * answers per message hash. The sdk's `sipaDepositsConsumed.sandbox.test.ts` holds the real lookup
 * and the account's key to the token contract.
 */
import type { Fr } from "@aztec-labs/aztec.js/fields"
import type { AztecAddress } from "@aztec-labs/aztec.js/addresses"
import type { Hex } from "viem"

export interface FakeEvent {
  salt: Fr
  resweepable?: boolean
  intentHash: Hex
}

export interface Claim {
  l2Token: string
  inboxIndex: bigint
  amount: bigint
  salt: string
}

const key = (a: { toString(): string }) => a.toString().toLowerCase()

export class FakeL2 {
  /** Every claim the token services ran, in order. */
  readonly claims: Claim[] = []
  /** Makes the claim of an inbox index throw. */
  claimError: (index: bigint) => Error | undefined = () => undefined
  /** Event reads, per token: each one takes the PXE. */
  eventReads = 0
  private readonly events = new Map<string, FakeEvent[]>()
  private readonly messages = new Map<string, bigint>()
  private readonly spent = new Set<string>()
  private leaves = 0n

  /** The `SIPA` event `l2Token` sends `recipient`. */
  emit(l2Token: string, recipient: AztecAddress, event: FakeEvent): void {
    const id = `${key(l2Token)}:${key(recipient)}`
    this.events.set(id, [...(this.events.get(id) ?? []), event])
  }

  /** The message lands in the tree: a claim of it can run. */
  settle(messageKey: Hex): void {
    this.messages.set(key(messageKey), this.leaves++)
  }

  /** The deposit `l2Token` holds under `messageKey` was spent, on this device or another. */
  spend(l2Token: string, messageKey: Hex): void {
    this.spent.add(`${key(l2Token)}:${key(messageKey)}`)
  }

  /** The consumed-deposit lookup: which of `messageKeys` were spent on `l2Token`, in order. */
  readConsumed = async (l2Token: AztecAddress, messageKeys: readonly Hex[]): Promise<boolean[]> =>
    messageKeys.map((messageKey) => this.spent.has(`${key(l2Token)}:${key(messageKey)}`))

  readonly wallet = {
    getPrivateEvents: async (
      _metadata: unknown,
      filter: { contractAddress: AztecAddress; scopes: AztecAddress[] },
    ) => {
      this.eventReads += 1
      const events = this.events.get(`${key(filter.contractAddress)}:${key(filter.scopes[0]!)}`)
      return (events ?? []).map(({ salt, resweepable = true, intentHash }) => {
        const hash = BigInt(intentHash)
        return {
          event: {
            shared_secret_salt: salt.toBigInt(),
            resweepable,
            intent_hash_hi: hash >> 128n,
            intent_hash_lo: hash & ((1n << 128n) - 1n),
          },
        }
      })
    },
  }

  /** The L2 head. */
  block = 30
  /** Makes the head read throw. */
  headError: Error | undefined

  readonly node = {
    getBlockNumber: async () => {
      if (this.headError) throw this.headError
      return this.block
    },
    getL1ToL2MessageIndex: async (hash: Fr) => this.messages.get(key(hash)),
    getBlockData: async () => ({
      header: { state: { l1ToL2MessageTree: { nextAvailableLeafIndex: Number(this.leaves) } } },
    }),
  }

  /** The token service of `l2Token`. */
  tokenService(l2Token: string) {
    return {
      claimSweptDeposit: async (args: {
        inboxIndex: bigint
        amount: bigint
        sharedSecretSalt: Fr
      }) => {
        const error = this.claimError(args.inboxIndex)
        if (error) throw error
        this.claims.push({
          l2Token,
          inboxIndex: args.inboxIndex,
          amount: args.amount,
          salt: args.sharedSecretSalt.toString(),
        })
      },
    }
  }
}
