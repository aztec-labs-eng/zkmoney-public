import { AztecAddress } from "@aztec/stdlib/aztec-address"
import { Fr } from "@aztec/aztec.js/fields"
import { publishContractClass, publishInstance } from "@aztec/aztec.js/deployment"
import type { AztecNode } from "@aztec/aztec.js/node"
import { BlockNumber } from "@aztec/foundation/branded-types"
import {
  HandshakeRegistryArtifact,
  getStandardHandshakeRegistry,
} from "@aztec/standard-contracts/handshake-registry"
import {
  ContractService,
  EcdsaK256AlphaAuthProvider,
  Network,
  NodeContractServiceStorage,
  ObsidionAccount,
} from "../../src/index.js"
import { ObsidionWalletTest } from "../../src/obsidion/ObsidionWalletTest.js"

/**
 * Publishes the HandshakeRegistry standard contract on-chain (class + instance) if not already
 * present, and registers the artifact with the wallet's PXE. Idempotent — safe to call from every
 * test file that exercises constrained delivery. Mirrors the vendored upstream helper
 * (end-to-end/src/fixtures/setup.ts `ensureHandshakeRegistryPublished`).
 */
export async function ensureHandshakeRegistryPublished(
  wallet: ObsidionWalletTest,
  from: AztecAddress,
): Promise<void> {
  const { instance, contractClass } = await getStandardHandshakeRegistry()
  if (
    !(await wallet.getContractClassMetadata(contractClass.id)).isContractClassPubliclyRegistered
  ) {
    await (await publishContractClass(wallet, HandshakeRegistryArtifact)).send({ from })
  }
  if (!(await wallet.getContractMetadata(instance.address)).isContractPublished) {
    await publishInstance(wallet, instance).send({ from })
  }
  await wallet.registerContract(instance, HandshakeRegistryArtifact)
}

/**
 * Creates a fresh (non-genesis-funded) Obsidion account on the given wallet's PXE. The account is
 * initializerless: nothing deploys it, its first (sponsored) transaction is an ordinary
 * `entrypoint`. Mirrors alpha_account.sandbox.test.ts `createAlphaTestAccount`.
 *
 * Pass `reuse` to rebuild an existing identity on another PXE — the address derives from
 * `secretKey`, so the same keys on an empty store are a device restore.
 */
export async function createFreshAccount(
  wallet: ObsidionWalletTest,
  reuse?: { secretKey: Fr; signingKey: Buffer },
): Promise<{
  account: ObsidionAccount
  authProvider: EcdsaK256AlphaAuthProvider
  secretKey: Fr
  signingKey: Buffer
}> {
  // Re-point the ContractService singleton at THIS wallet's PXE before creating the account:
  // ObsidionAccountContractManager captures ContractService.getInstance() and registers the
  // account contract + keys on the singleton's PXE. Without this, a second-PXE account silently
  // registers on the first PXE (see the proving-PXE note in alpha_account.sandbox.test.ts). Captured
  // references in previously created managers keep pointing at their original instance.
  ContractService.resetInstance()
  ContractService.getInstance(
    new NodeContractServiceStorage(Network.SANDBOX),
    wallet.node,
    wallet.pxe,
    Network.SANDBOX,
    { source: "local-ledger", oxideEnvProfile: null },
  )

  const signingKey = reuse?.signingKey ?? new Fr(Fr.random().toBigInt() % Fr.MODULUS).toBuffer()
  const authProvider = new EcdsaK256AlphaAuthProvider(signingKey)
  const secretKey = reuse?.secretKey ?? Fr.random()
  const account = await wallet.createObsidionAccount(secretKey, authProvider)
  return { account, authProvider, secretKey, signingKey }
}

/** The `{from, to, amount}` field shape of the token `Transfer` events. */
export interface TransferEventFields {
  from: { toString(): string }
  to: { toString(): string }
  amount: bigint
}

/**
 * Scans the recipient's discovered private events (syncing their PXE first) and returns the
 * transfer events addressed to them with the given amount — pass the matching event definition.
 */
export async function findIncomingTransfers(
  wallet: ObsidionWalletTest,
  node: AztecNode,
  eventDef: unknown,
  contractAddress: { toString(): string },
  recipient: { toString(): string },
  amount: bigint,
): Promise<TransferEventFields[]> {
  const currentBlock = await node.getBlockNumber()
  const events = await wallet.getPrivateEvents<TransferEventFields>(eventDef as any, {
    contractAddress: contractAddress as any,
    fromBlock: BlockNumber(1),
    toBlock: BlockNumber(currentBlock + 1),
    scopes: [recipient as any],
  })
  return events
    .map(({ event }) => event)
    .filter((ev) => ev.to.toString() === recipient.toString() && BigInt(ev.amount) === amount)
}

/**
 * Per-role transaction tally the spike legs feed and the evaluation doc reads. Roles are
 * free-form ("sender", "recipient", "infra"). Log the summary at the end of each leg so the
 * numbers in docs/handshake/handshake-registry-evaluation.md come from real runs.
 */
export class TxTally {
  private counts = new Map<string, number>()

  record(role: string, label: string): void {
    this.counts.set(role, (this.counts.get(role) ?? 0) + 1)
    console.log(`[tx-tally] ${role}: ${label}`)
  }

  get(role: string): number {
    return this.counts.get(role) ?? 0
  }

  summary(): Record<string, number> {
    return Object.fromEntries(this.counts)
  }
}
