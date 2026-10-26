/**
 * Shared alpha-account OxideToken bring-up for the leg-2 and stretch tests. Mirrors
 * `setupOxideTokenSandbox` but drives every L2-sending role with fresh alpha accounts: the
 * Schnorr fixture accounts cannot execute payloads with public calls through this wallet
 * ("Failed to get a note" in the entrypoint — breakage that currently affects the shared harness
 * on a fresh sandbox), while alpha accounts handle them fine.
 *
 * Shape: fresh alpha relayer + sender on PXE A, L1 Nitro/TEE portal stack with its OxideToken,
 * TEE signer registration, L1 deposit → L2 claim funding the sender, then PXE B with a fresh
 * recipient and the token registered. `publishHandshakeRegistry` is for the constrained-delivery
 * stretch: under the flip even the deploy/claim sends route through the registry, so it must be
 * published before the first send.
 */
import { AztecAddress, EthAddress } from "@aztec-labs/aztec.js/addresses"
import { Fr } from "@aztec-labs/aztec.js/fields"
import { AztecNode } from "@aztec-labs/aztec.js/node"
import { LocalTeeSigner } from "@oxide/tee-enclave/signer.js"
import type { SpendMetadataResolver } from "@oxide/oxide-client/token_operations_collector.js"
import { parseUnits } from "viem"
import { DEFAULT_CONTRACTS, Network, ObsidionAccount, TokenService } from "../../src/index.js"
import { setupTest, setupAdditionalPXE } from "../utils/helper.js"
import {
  l1DepositAndClaimPrivateBalance,
  linkSandboxTeeSigner,
  publishThrough,
  tryDeploySandboxTeePortalStack,
} from "../utils/oxideTokenSandbox.js"
import { awaitTeeRegistrationMessage } from "../utils/tee/registerTeeSigner.js"
import { ObsidionWalletTest } from "../../src/obsidion/ObsidionWalletTest.js"
import { createFreshAccount, ensureHandshakeRegistryPublished, TxTally } from "./helpers.js"

export const SPIKE_DECIMALS = 6

export interface OxideTokenSpike {
  node: AztecNode
  walletA: ObsidionWalletTest
  walletB: ObsidionWalletTest
  sender: ObsidionAccount
  recipient: ObsidionAccount
  senderResolver: SpendMetadataResolver
  senderTokenService: TokenService
  recipientTokenService: TokenService
  tokenAddress: AztecAddress
}

export async function bringUpOxideTokenSpike(options: {
  fundHuman: string
  publishHandshakeRegistry?: boolean
  tally?: TxTally
}): Promise<OxideTokenSpike> {
  const recordInfra = (label: string) => options.tally?.record("infra", label)

  const setup = await setupTest()
  const walletA = setup.wallet
  const node = setup.node
  const { contractService, sponsoredFeePaymentMethod } = setup

  // Fresh alpha accounts drive every L2 send: a relayer/deployer plus the sender under test.
  const { account: relayerAlpha } = await createFreshAccount(walletA)
  const { account: sender } = await createFreshAccount(walletA)
  const senderResolver = await sender.makeSpendMetadataResolver()

  if (options.publishHandshakeRegistry) {
    await ensureHandshakeRegistryPublished(walletA, relayerAlpha.getAddress())
    recordInfra("HandshakeRegistry publish (one-time, idempotent)")
  }

  const senderTokenService = await TokenService.create(walletA, sender)
  const unlinked = LocalTeeSigner.random({
    l1Portal: EthAddress.ZERO,
    l2Token: AztecAddress.ZERO,
    teeRegistry: EthAddress.ZERO,
  })
  const publisher = publishThrough(senderTokenService, relayerAlpha)
  const oxideStack = await tryDeploySandboxTeePortalStack(node, unlinked, {
    publishL2Token: publisher.publishL2Token,
    tokenName: "USD Coin",
    tokenSymbol: "USDC",
  })
  if (!oxideStack) {
    throw new Error(
      "OxideToken spike requires Anvil on L1 (part of `aztec start --local-network`).",
    )
  }
  const tokenContract = publisher.published()
  recordInfra("L1 oxide stack + OxideToken publish + TEE registration on L1 (one-time)")

  await contractService.setContractAddress(DEFAULT_CONTRACTS.oxideToken, tokenContract.address)
  await awaitTeeRegistrationMessage({
    wallet: walletA,
    registration: oxideStack.teeRegistration,
    network: Network.SANDBOX,
  })
  const { teeSigner } = linkSandboxTeeSigner(unlinked, oxideStack)
  senderTokenService.setTeeSigner(teeSigner)
  recordInfra("TEE registration message on L2 (one-time)")

  // Fund the fresh sender through the production path: L1 deposit + L2 claim.
  await l1DepositAndClaimPrivateBalance({
    oxideStack,
    wallet: walletA,
    recipient: sender.getAddress(),
    amount: parseUnits(options.fundHuman, SPIKE_DECIMALS),
    sharedSecretFr: Fr.random(),
    tokenContract,
  })
  recordInfra("L1 deposit + L2 claim funding the fresh sender (one-time)")

  // PXE B shares the node; the fresh recipient's keys exist only here.
  const setupB = await setupAdditionalPXE(node)
  const walletB = setupB.wallet
  const { account: recipient } = await createFreshAccount(walletB)
  if (options.publishHandshakeRegistry) {
    await ensureHandshakeRegistryPublished(walletB, setupB.accounts[0]!.getAddress())
  }

  // Register the deployed token on PXE B and bind a recipient-side TokenService. No relayerUrl —
  // passing one would trigger the relayer-sender registration side effect.
  const tokenInstance = await node.getContract(tokenContract.address)
  if (!tokenInstance) {
    throw new Error("deployed OxideToken instance not found on the node")
  }
  const bridgeArtifact = await contractService.getArtifactForContract(DEFAULT_CONTRACTS.oxideToken)
  await walletB.pxe.registerContractClass(bridgeArtifact)
  await walletB.pxe.registerContract(tokenInstance)
  const recipientTokenService = await TokenService.create(
    walletB,
    recipient,
    tokenContract.address,
    teeSigner,
  )

  return {
    node,
    walletA,
    walletB,
    sender,
    recipient,
    senderResolver,
    senderTokenService,
    recipientTokenService,
    tokenAddress: tokenContract.address,
  }
}
