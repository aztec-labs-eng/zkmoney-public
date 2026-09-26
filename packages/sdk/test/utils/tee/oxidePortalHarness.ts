import { AztecAddress } from "@aztec/aztec.js/addresses"
import { createExtendedL1Client } from "@aztec/ethereum/client"
import { deployL1Contract } from "@aztec/ethereum/deploy-l1-contract"
import { EthAddress } from "@aztec/foundation/eth-address"
import type { Buffer32 } from "@aztec/foundation/buffer"
import {
  deployNamePortal,
  deployNameRegistryStack,
  updateDomainOwner,
  updateRegistrationController,
  deployFrozenDepositRefundVerifier,
  deployFrozenNotesRefundVerifier,
  deployNitroValidator,
  deployOxidePortal,
  deployPlainWithdrawalExecutor,
  DEPOSIT_SWEEP_FEE,
  REGISTRATION_SWEEP_FEE,
  deploySIPAImplementations,
  deployRegistrationController,
  deployUnprocessedDepositRefundVerifier,
  OxideAccountFactoryAbi,
  OxideAccountFactoryBytecode,
  OxidePortalAbi,
  TestERC20Abi,
  TestERC20Bytecode,
  type OxidePortalContract,
} from "@oxide/l1-contracts"
import type { P256PublicKey } from "@oxide/oxide-lib/encryption.js"
import {
  getContract,
  type Address,
  type Chain,
  type Hex,
  type PublicClient,
  type WalletClient,
} from "viem"

import { generateTestAttestation, type TestAttestationFixture } from "./gen_test_attestation.js"
import { deployTestCertManager } from "./deploy_test_cert_manager.js"

const ONE_ETH = 10n ** 18n
const CAPS_RATE = ONE_ETH
const CAPS_GLOBAL_LIMIT = 500_000n * ONE_ETH
/** The sweep fees the two intent implementations pin — oxide's own defaults, so a harness sweep
 *  costs what a deployed one does. */
export const HARNESS_DEPOSIT_FEE = DEPOSIT_SWEEP_FEE
export const HARNESS_REGISTRATION_FEE = REGISTRATION_SWEEP_FEE

export interface AztecL1Wiring {
  registry: EthAddress
  rollup: EthAddress
  inbox: EthAddress
  outbox: EthAddress
  rollupVersion: bigint
}

function requireEthAddress(value: unknown, name: string): EthAddress {
  if (value == null || value === "") {
    throw new Error(
      `Aztec L1 wiring missing ${name} — is \`aztec start --local-network\` fully up? ` +
        `node_getNodeInfo must return l1ContractAddresses.${name}.`,
    )
  }
  if (value instanceof EthAddress) {
    return value
  }
  return EthAddress.fromString(String(value))
}

export function aztecL1WiringFromNodeInfo(nodeInfo: {
  rollupVersion: number
  l1ContractAddresses: {
    registryAddress?: unknown
    rollupAddress?: unknown
    inboxAddress?: unknown
    outboxAddress?: unknown
  }
}): AztecL1Wiring {
  const l1 = nodeInfo.l1ContractAddresses
  return {
    registry: requireEthAddress(l1.registryAddress, "registryAddress"),
    rollup: requireEthAddress(l1.rollupAddress, "rollupAddress"),
    inbox: requireEthAddress(l1.inboxAddress, "inboxAddress"),
    outbox: requireEthAddress(l1.outboxAddress, "outboxAddress"),
    rollupVersion: BigInt(nodeInfo.rollupVersion),
  }
}

export interface TEEDraftKeys {
  pubKeyX: Buffer32
  pubKeyY: Buffer32
  ethAddress: EthAddress
  encryptionPublicKey: P256PublicKey
}

/**
 * Registration payment policy (registration-by-deposit). Given, the harness deploys a fresh
 * `OxideAccountFactory` plus a RegistrationController with these args (feeToken = the test token,
 * `feeBeneficiary` = beneficiary id 0) and blesses it on the registry, so registration sweeps run;
 * omitted, no controller exists and only the plain deposit + broadcast paths work.
 */
export type RegistrationDeployOpts = {
  domainOwner: Address
  feeBeneficiary: Address
  registrationMin: bigint
  registrationFee: bigint
  /**
   * The portal's `FPC_FUNDING_CUT`, skimmed off every deposit and withdrawal. Zero by default so
   * amounts arrive whole; a suite that prices the cut sets it, and the deployer receives it.
   */
  fpcFundingCut?: bigint
}

export interface DeploymentResultWithNitro {
  tokenPortal: Address
  testToken: Address
  registryAddress: Address
  /** The oxide NameRegistry — NOT `registryAddress`, which is the Aztec rollup registry. */
  nameRegistry: Address
  /** Where user records live; the NameRegistry holds only the name → owner mapping. */
  accountMetadataRegistry: Address
  /**
   * The permanent CREATE2 deployer of every SIPA, and the registry of blessed implementations it
   * will clone. A SIPA deployed anywhere else derives a different address, so tests must use it.
   */
  sipaFactory: Address
  /** The CCIP resolution module blessed as the registry's `latestResolver`. */
  sipaResolver: Address
  /** The `OxideAccountFactory` register() predicts owners from + deploys — present only with `registration`. */
  accountFactory?: Address
  /** The NamePortal the controller notifies a claimed name through — present only with `registration`. */
  namePortal?: Address
  /** Every withdrawal settles into it; it pays the relayer tip and forwards the rest. */
  plainWithdrawalExecutor: Address
  /** Blessed on `sipaFactory` and served under this stack's rollup version. Each pins its own
   *  `depositFee()`; the harness gives the registration one the heavier fee. */
  depositSIPAImplementation: Address
  registrationSIPAImplementation: Address
  portal: OxidePortalContract
  nitroValidatorAddress: Address
  certManagerAddress: Address
  frozenNotesRefundVerifierAddress: Address
  frozenDepositRefundVerifierAddress: Address
  unprocessedDepositRefundVerifierAddress: Address
  fixture: TestAttestationFixture
}

export async function deploySandboxOxidePortalStack(
  walletClient: WalletClient,
  publicClient: PublicClient,
  aztec: AztecL1Wiring,
  teeKeys: TEEDraftKeys,
  options: {
    relayerPrivateKey: Hex
    l1Chain: Chain
    l1RpcUrl: string
    l1ChainTimestampMillis?: number
    // Bind the portal to an already-deployed underlying ERC20 (cross-generation
    // reclaim tests) instead of deploying a fresh one.
    existingTestToken?: Address
    // Deploy a real register()-capable registry (+ a fresh OxideAccountFactory) instead of the
    // placeholder-arg one; feeToken is the test token so a funded SIPA can pay the registration fee.
    registration?: RegistrationDeployOpts
  },
): Promise<DeploymentResultWithNitro> {
  const account = walletClient.account!
  const owner = EthAddress.fromString(account.address)

  let testToken: Address
  if (options.existingTestToken) {
    testToken = options.existingTestToken
  } else {
    const tokenHash = await walletClient.deployContract({
      account,
      chain: walletClient.chain!,
      abi: TestERC20Abi,
      bytecode: TestERC20Bytecode,
      args: ["BOLD", "BOLD", account.address],
    })
    const tokenReceipt = await publicClient.waitForTransactionReceipt({ hash: tokenHash })
    testToken = tokenReceipt.contractAddress!
  }

  const fixture = generateTestAttestation({
    pubKeyX: teeKeys.pubKeyX,
    pubKeyY: teeKeys.pubKeyY,
    encPubKeyX: teeKeys.encryptionPublicKey.x,
    encPubKeyY: teeKeys.encryptionPublicKey.y,
    timestampMillis: options.l1ChainTimestampMillis,
  })

  const extendedClient = createExtendedL1Client(
    [options.l1RpcUrl],
    options.relayerPrivateKey,
    options.l1Chain,
  )

  const certManagerEth = await deployTestCertManager(extendedClient, fixture.rootArgs)
  const nitroValidatorEth = await deployNitroValidator(extendedClient, certManagerEth)
  // Without `registration` opts nothing here resolves or REGISTERS a name, so the verifier /
  // factory slots take the owner address (the constructor only rejects a zero factory) and no
  // payment policy exists. With them, deploy a real register()-capable stack over a fresh
  // OxideAccountFactory: registration sweeps resolve the payment policy live via
  // `nameRegistry.registrationController()`, so a RegistrationController (test token as fee token,
  // `feeBeneficiary` seeded as beneficiary id 0) is deployed and blessed. The NameRegistry is
  // deployed with the DEPLOYER as domain owner so the bless needs no extra key, then ownership is
  // handed to `reg.domainOwner` before any claim is signed.
  // Deploy through `extendedClient`, the same relayer-key client the surrounding stack deploys use;
  // a `walletClient` tx here would advance the relayer nonce out from under it (later txs revert
  // "nonce too low").
  let accountFactory: Address | undefined
  if (options.registration) {
    accountFactory = String(
      (
        await deployL1Contract(
          extendedClient,
          OxideAccountFactoryAbi,
          OxideAccountFactoryBytecode,
          [],
        )
      ).address,
    ) as Address
  }
  const reg = options.registration
  const { nameRegistry, accountMetadataRegistry, sipaFactory, sipaResolver } =
    await deployNameRegistryStack(walletClient, publicClient, account.address, account.address)
  let namePortal: Address | undefined
  if (reg) {
    // Bound to the NameRegistry and the Aztec Registry it resolves a rollup version's Inbox
    // through; the controller binds it immutably, so it is deployed first.
    namePortal = await deployNamePortal(
      walletClient,
      publicClient,
      nameRegistry,
      aztec.registry.toString() as Address,
    )
    const registrationController = await deployRegistrationController(
      walletClient,
      publicClient,
      nameRegistry,
      sipaFactory,
      accountFactory ?? account.address,
      namePortal,
      testToken,
      reg.registrationMin,
      reg.registrationFee,
      reg.feeBeneficiary,
    )
    await updateRegistrationController(
      walletClient,
      publicClient,
      nameRegistry,
      registrationController,
    )
    await updateDomainOwner(walletClient, publicClient, nameRegistry, reg.domainOwner)
  }
  const frozenNotesVerifierEth = await deployFrozenNotesRefundVerifier(extendedClient)
  const frozenDepositVerifierEth = await deployFrozenDepositRefundVerifier(extendedClient)
  const unprocessedDepositVerifierEth = await deployUnprocessedDepositRefundVerifier(extendedClient)

  const portal = await deployOxidePortal(extendedClient, {
    owner,
    // The portal skims a cut of deposits/withdrawals to an L1 FPCFunder that tops up the ClaimFPC.
    // A zero cut keeps deposited amounts whole, which is what most balance assertions here expect,
    // and leaves the funder inert -- the payout is guarded on `cut > 0`. A suite that sets a cut
    // has it paid to the deployer.
    fpcFunder: reg?.fpcFundingCut ? owner : EthAddress.ZERO,
    fpcFundingCut: reg?.fpcFundingCut ?? 0n,
    certManager: certManagerEth,
    nitroValidator: nitroValidatorEth,
    underlying: EthAddress.fromString(testToken),
    registry: aztec.registry,
    rollupVersion: aztec.rollupVersion,
    verifiers: {
      frozenNotes: frozenNotesVerifierEth,
      frozenDeposit: frozenDepositVerifierEth,
      unprocessedDeposit: unprocessedDepositVerifierEth,
    },
    rate: CAPS_RATE,
    globalLimit: CAPS_GLOBAL_LIMIT,
  })

  const { depositSIPAImplementation, registrationSIPAImplementation } =
    await deploySIPAImplementations(walletClient, publicClient, {
      sipaFactory,
      portal: portal.address.toString() as Address,
      nameRegistry,
      depositFee: HARNESS_DEPOSIT_FEE,
      registrationFee: HARNESS_REGISTRATION_FEE,
    })
  const plainWithdrawalExecutor = await deployPlainWithdrawalExecutor(
    extendedClient,
    portal.address,
  )

  return {
    tokenPortal: portal.address.toString() as Address,
    testToken,
    registryAddress: aztec.registry.toString() as Address,
    nameRegistry,
    accountMetadataRegistry,
    sipaFactory,
    sipaResolver,
    accountFactory,
    namePortal,
    plainWithdrawalExecutor: plainWithdrawalExecutor.toString() as Address,
    depositSIPAImplementation,
    registrationSIPAImplementation,
    portal,
    nitroValidatorAddress: nitroValidatorEth.toString() as Address,
    certManagerAddress: certManagerEth.toString() as Address,
    frozenNotesRefundVerifierAddress: frozenNotesVerifierEth.toString() as Address,
    frozenDepositRefundVerifierAddress: frozenDepositVerifierEth.toString() as Address,
    unprocessedDepositRefundVerifierAddress: unprocessedDepositVerifierEth.toString() as Address,
    fixture,
  }
}

export async function initializePortal(
  walletClient: WalletClient,
  publicClient: PublicClient,
  portalAddress: Address,
  l2BridgeAddress: AztecAddress,
): Promise<void> {
  const portal = getContract({
    address: portalAddress,
    abi: OxidePortalAbi,
    client: { public: publicClient, wallet: walletClient },
  })
  const hash = await portal.write.initialize([l2BridgeAddress.toString()], {
    account: walletClient.account!,
    chain: walletClient.chain!,
  })
  await publicClient.waitForTransactionReceipt({ hash })
}

export async function mintTestTokens(
  walletClient: WalletClient,
  publicClient: PublicClient,
  tokenAddress: Address,
  recipient: Address,
  amount: bigint,
): Promise<void> {
  const token = getContract({
    address: tokenAddress,
    abi: TestERC20Abi,
    client: { public: publicClient, wallet: walletClient },
  })
  const hash = await token.write.mint([recipient, amount], {
    account: walletClient.account!,
    chain: walletClient.chain!,
  })
  await publicClient.waitForTransactionReceipt({ hash })
}
