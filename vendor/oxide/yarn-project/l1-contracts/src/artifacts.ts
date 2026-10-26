// Barrel re-export of the typed (`as const`) ABI + bytecode constants emitted by
// `scripts/gen_abis.mjs`. Use these everywhere instead of `assert { type: 'json' }` imports of
// the foundry artifacts — viem's contract-handle inference only narrows method return types
// when the ABI is an `as const` literal the TS compiler can see.

export { CertManagerAbi, CertManagerBytecode } from './abis/CertManager.js';
export { FrozenNotesRefundVerifierAbi, FrozenNotesRefundVerifierBytecode } from './abis/FrozenNotesRefundVerifier.js';
export {
  FrozenDepositsRefundVerifierAbi,
  FrozenDepositsRefundVerifierBytecode,
} from './abis/FrozenDepositsRefundVerifier.js';
export {
  UnprocessedDepositRefundVerifierAbi,
  UnprocessedDepositRefundVerifierBytecode,
} from './abis/UnprocessedDepositRefundVerifier.js';
export { MockCertManagerAbi, MockCertManagerBytecode } from './abis/MockCertManager.js';
export { MockNitroValidatorAbi, MockNitroValidatorBytecode } from './abis/MockNitroValidator.js';
export { TestERC20Abi } from '@aztec-foundation/l1-artifacts/TestERC20Abi';
export { TestERC20Bytecode } from '@aztec-foundation/l1-artifacts/TestERC20Bytecode';
export { NitroValidatorAbi, NitroValidatorBytecode } from './abis/NitroValidator.js';
export { TeeRegistryAbi, TeeRegistryBytecode } from './abis/TeeRegistry.js';
export { PlainWithdrawalExecutorAbi, PlainWithdrawalExecutorBytecode } from './abis/PlainWithdrawalExecutor.js';
export { FirstProverProofSubmitterAbi, FirstProverProofSubmitterBytecode } from './abis/FirstProverProofSubmitter.js';
export { DepositSubsidyAbi, DepositSubsidyBytecode } from './abis/DepositSubsidy.js';
export { IFPCFunderAbi } from './abis/IFPCFunder.js';
export { ErrorsAbi } from './abis/Errors.js';
export { PlainWithdrawalSubsidyAbi, PlainWithdrawalSubsidyBytecode } from './abis/PlainWithdrawalSubsidy.js';
export { MigrationExecutorAbi, MigrationExecutorBytecode } from './abis/MigrationExecutor.js';
export { MigrationSubsidyAbi, MigrationSubsidyBytecode } from './abis/MigrationSubsidy.js';
export { ProverSubsidyAbi, ProverSubsidyBytecode } from './abis/ProverSubsidy.js';
export { OxidePortalAbi, OxidePortalBytecode } from './abis/OxidePortal.js';
export { PortalFactoryAbi, PortalFactoryBytecode } from './abis/PortalFactory.js';
export { MockRollupAbi, MockRollupBytecode } from './abis/MockRollup.js';
export { TestCertManagerAbi, TestCertManagerBytecode } from './abis/TestCertManager.js';

// Periphery: name registry + stealth-deposit resolver.
export { MockPortalAbi, MockPortalBytecode } from './abis/MockPortal.js';
export { MockLegacyDepositPoolAbi, MockLegacyDepositPoolBytecode } from './abis/MockLegacyDepositPool.js';
export { MockVerifierAbi, MockVerifierBytecode } from './abis/MockVerifier.js';
export { MockV3AggregatorAbi, MockV3AggregatorBytecode } from './abis/MockV3Aggregator.js';
export { MintableTokenAbi, MintableTokenBytecode } from './abis/MintableToken.js';
export { NameRegistryAbi, NameRegistryBytecode } from './abis/NameRegistry.js';
export { AccountMetadataRegistryAbi, AccountMetadataRegistryBytecode } from './abis/AccountMetadataRegistry.js';
export { RegistrationControllerAbi, RegistrationControllerBytecode } from './abis/RegistrationController.js';
export { NamePortalAbi, NamePortalBytecode } from './abis/NamePortal.js';
export { SIPAAbi, SIPABytecode } from './abis/SIPA.js';
export { DepositSIPAAbi, DepositSIPABytecode } from './abis/DepositSIPA.js';
export { RegistrationSIPAAbi, RegistrationSIPABytecode } from './abis/RegistrationSIPA.js';
export { UserOpSIPAAbi, UserOpSIPABytecode } from './abis/UserOpSIPA.js';
export { AccountMetadataControllerAbi } from './abis/AccountMetadataController.js';
export { SIPAFactoryAbi, SIPAFactoryBytecode } from './abis/SIPAFactory.js';
export { ForwardingTableAbi, ForwardingTableBytecode } from './abis/ForwardingTable.js';
export { SIPAResolverAbi, SIPAResolverBytecode } from './abis/SIPAResolver.js';
export { OperationExecutorAbi, OperationExecutorBytecode } from './abis/OperationExecutor.js';
export { MockOperationAbi, MockOperationBytecode } from './abis/MockOperation.js';
export { MockCatchingOperationAbi, MockCatchingOperationBytecode } from './abis/MockCatchingOperation.js';
export { MockOncePerBlockOperationAbi, MockOncePerBlockOperationBytecode } from './abis/MockOncePerBlockOperation.js';
export { FPCFunderTestnetAbi, FPCFunderTestnetBytecode } from './abis/FPCFunderTestnet.js';
export { FPCFunderDAIAbi, FPCFunderDAIBytecode } from './abis/FPCFunderDAI.js';
export { MockSwapRouterAbi, MockSwapRouterBytecode } from './abis/MockSwapRouter.js';
export { EscrowBaseAbi } from './abis/EscrowBase.js';
// Swap-on-withdraw feature (disposable — purge these with `src/swap_on_withdraw.ts`).
export { SwapEscrowAbi, SwapEscrowBytecode } from './abis/SwapEscrow.js';
export { SwapEscrowFactoryAbi, SwapEscrowFactoryBytecode } from './abis/SwapEscrowFactory.js';
export { MockUniversalRouterAbi, MockUniversalRouterBytecode } from './abis/MockUniversalRouter.js';
export { MockCurve3PoolAbi, MockCurve3PoolBytecode } from './abis/MockCurve3Pool.js';
export { MockUniswapV2PairAbi, MockUniswapV2PairBytecode } from './abis/MockUniswapV2Pair.js';
export { MockWETH9Abi, MockWETH9Bytecode } from './abis/MockWETH9.js';
// CCTP bridge-on-withdraw feature (disposable — purge these with `src/cctp_bridge_on_withdraw.ts`).
export { CCTPBridgeEscrowAbi, CCTPBridgeEscrowBytecode } from './abis/CCTPBridgeEscrow.js';
export { CCTPBridgeEscrowFactoryAbi, CCTPBridgeEscrowFactoryBytecode } from './abis/CCTPBridgeEscrowFactory.js';
export { MockTokenMessengerV2Abi, MockTokenMessengerV2Bytecode } from './abis/MockTokenMessengerV2.js';
// Across bridge-on-withdraw feature (disposable — purge these with `src/across_bridge_on_withdraw.ts`).
export { AcrossBridgeEscrowAbi, AcrossBridgeEscrowBytecode } from './abis/AcrossBridgeEscrow.js';
export { AcrossBridgeEscrowFactoryAbi, AcrossBridgeEscrowFactoryBytecode } from './abis/AcrossBridgeEscrowFactory.js';
export { MockAcrossSpokePoolAbi, MockAcrossSpokePoolBytecode } from './abis/MockAcrossSpokePool.js';
export { OxideAccountAbi, OxideAccountBytecode } from './abis/OxideAccount.js';
export { OxideAccountFactoryAbi, OxideAccountFactoryBytecode } from './abis/OxideAccountFactory.js';
export { EntryPointAbi, EntryPointBytecode } from './abis/EntryPoint.js';
export { OxidePaymasterAbi, OxidePaymasterBytecode } from './abis/OxidePaymaster.js';
export {
  ResolverVerifierAbi,
  ResolverVerifierBytecode,
  ResolverVerifierLinkReferences,
} from './abis/ResolverVerifier.js';
export { ZKTranscriptLibAbi, ZKTranscriptLibBytecode } from './abis/ZKTranscriptLib.js';
export { ResolverRelationsLibAbi, ResolverRelationsLibBytecode } from './abis/ResolverRelationsLib.js';
