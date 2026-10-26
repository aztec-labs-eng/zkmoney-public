export {
  CertManagerAbi,
  CertManagerBytecode,
  FrozenNotesRefundVerifierAbi,
  FrozenNotesRefundVerifierBytecode,
  FrozenDepositsRefundVerifierAbi,
  FrozenDepositsRefundVerifierBytecode,
  UnprocessedDepositRefundVerifierAbi,
  UnprocessedDepositRefundVerifierBytecode,
  MockCertManagerAbi,
  MockCertManagerBytecode,
  MockNitroValidatorAbi,
  MockNitroValidatorBytecode,
  TestERC20Abi,
  TestERC20Bytecode,
  NitroValidatorAbi,
  NitroValidatorBytecode,
  TeeRegistryAbi,
  TeeRegistryBytecode,
  FirstProverProofSubmitterAbi,
  FirstProverProofSubmitterBytecode,
  DepositSubsidyAbi,
  DepositSubsidyBytecode,
  IFPCFunderAbi,
  ErrorsAbi,
  PlainWithdrawalSubsidyAbi,
  PlainWithdrawalSubsidyBytecode,
  ProverSubsidyAbi,
  ProverSubsidyBytecode,
  PlainWithdrawalExecutorAbi,
  PlainWithdrawalExecutorBytecode,
  MigrationExecutorAbi,
  MigrationExecutorBytecode,
  MigrationSubsidyAbi,
  MigrationSubsidyBytecode,
  OxidePortalAbi,
  OxidePortalBytecode,
  PortalFactoryAbi,
  PortalFactoryBytecode,
  TestCertManagerAbi,
  TestCertManagerBytecode,
} from './artifacts.js';
export {
  type PortalRefundVerifiers,
  type DeployPortalFactoryArgs,
  deployFrozenNotesRefundVerifier,
  deployFrozenDepositsRefundVerifier,
  deployUnprocessedDepositRefundVerifier,
  deployNitroValidator,
  type DeployTeeRegistryArgs,
  deployTeeRegistry,
  deployFirstProverProofSubmitter,
  deployDepositSubsidy,
  deployProverSubsidy,
  deployPlainWithdrawalExecutor,
  type DeployMigrationExecutorArgs,
  deployMigrationExecutor,
  deployPortalFactory,
} from './deploy/index.js';
export { OxidePortalEventsAbi } from './events.js';
export {
  type DepositEvent,
  type ProverClaim,
  type ProverClaimArgs,
  type ExecutorCall,
  encodeExecutorCall,
  OxidePortalContract,
} from './oxide_portal.js';
export { type PortalArgs, PortalFactoryContract } from './portal_factory.js';
export { type TEEKeys, TeeRegistryContract } from './tee_registry.js';

// Periphery: name registry + stealth-deposit resolver.
export {
  EntryPointAbi,
  EntryPointBytecode,
  OxidePaymasterAbi,
  OxidePaymasterBytecode,
  MockPortalAbi,
  MockPortalBytecode,
  MockVerifierAbi,
  MockVerifierBytecode,
  MockV3AggregatorAbi,
  MockV3AggregatorBytecode,
  MintableTokenAbi,
  MintableTokenBytecode,
  OxideAccountAbi,
  OxideAccountFactoryAbi,
  OxideAccountFactoryBytecode,
  NameRegistryAbi,
  NameRegistryBytecode,
  AccountMetadataRegistryAbi,
  AccountMetadataRegistryBytecode,
  RegistrationControllerAbi,
  RegistrationControllerBytecode,
  NamePortalAbi,
  NamePortalBytecode,
  ResolverVerifierAbi,
  ResolverVerifierBytecode,
  ResolverVerifierLinkReferences,
  DepositSIPAAbi,
  DepositSIPABytecode,
  RegistrationSIPAAbi,
  RegistrationSIPABytecode,
  SIPAAbi,
  SIPABytecode,
  SIPAFactoryAbi,
  SIPAFactoryBytecode,
  ForwardingTableAbi,
  ForwardingTableBytecode,
  SIPAResolverAbi,
  SIPAResolverBytecode,
  OperationExecutorAbi,
  OperationExecutorBytecode,
  MockOperationAbi,
  MockOperationBytecode,
  MockCatchingOperationAbi,
  MockCatchingOperationBytecode,
  MockOncePerBlockOperationAbi,
  MockOncePerBlockOperationBytecode,
  FPCFunderTestnetAbi,
  FPCFunderTestnetBytecode,
  MockSwapRouterAbi,
  MockSwapRouterBytecode,
  ZKTranscriptLibAbi,
  ZKTranscriptLibBytecode,
} from './artifacts.js';
export {
  deployContract,
  deployEntryPoint,
  deployOxidePaymaster,
  deployMockPortal,
  deployMockLegacyDepositPool,
  deployOxideAccountFactory,
  deployNameRegistry,
  deployAccountMetadataRegistry,
  deployNameRegistryStack,
  deployRegistrationController,
  deployDepositSIPA,
  deployRegistrationSIPA,
  DEFAULT_FORWARDING_TABLE_INTENTS,
  DEPOSIT_SWEEP_FEE,
  REGISTRATION_SWEEP_FEE,
  deployForwardingTable,
  deploySIPAImplementations,
  blessForwardingTable,
  blessSIPAImplementation,
  deployNamePortal,
  deploySIPAFactory,
  deploySIPAResolver,
  deployResolverVerifierAndZkTranscriptLib,
  deployZKTranscriptLib,
  deployOperationExecutor,
  linkBytecode,
} from './deploy/index.js';
export type {
  ForwardingTableInitialRow,
  ForwardingTableIntentFees,
  LinkLibraries,
  LinkReferences,
  SIPAImplementations,
} from './deploy/index.js';
export {
  addBeneficiary,
  readIsBeneficiary,
  readMetadataStateHash,
  readR1InstallGas,
  readRegistrationFee,
  readRegistrationMin,
} from './registration_controller.js';
export {
  buildNameClaimTypedData,
  changeName,
  claimName,
  encodeChangeName,
  readAccountMetadataRegistry,
  readDomainOwner,
  readResolver,
  readNameOf,
  readRegistrationController,
  readUserAddress,
  signDomainAuth,
  updateAccountMetadataRegistry,
  updateDomainOwner,
  updateRegistrationController,
  updateResolver,
} from './name_registry.js';
export type { DomainAuthArg, NameClaimTypedData, NameClaimTypedDataArgs } from './name_registry.js';
export {
  encodeSetUserRecord,
  encodeUpdateL2Address,
  encodeUpdatePublicKey,
  encodeUpdateUserResolverOperator,
  getUserRecord,
  hasUserRecord,
  readResolverOperator,
  setUserRecord,
  setResolverOperator,
  encodeUserRecordMetadata,
  userRecordStateHash,
} from './account_metadata_registry.js';
export type { K1PointArg, UserRecordArg, ResolverOperatorArg } from './account_metadata_registry.js';
export { callResolve, encodeResolve, resolveName, resolveWithProof } from './sipa_resolver.js';
export {
  SipaIntent,
  encodeDeploySIPA,
  predictSIPA,
  readApprovedTable,
  readBlessedIntent,
  readSIPAImplementation,
} from './sipa_factory.js';
export type { SipaDeployArgs } from './sipa_factory.js';
// ERC-4337 account: a user's stable identity, deployed by a CREATE2 factory.
export {
  type AuthKeyEntry,
  type Call,
  type R1PublicKeyArg,
  type WebAuthnAuthArg,
  predictAccountAddress,
  predictAccountAddressLocally,
  DUMMY_K1_SIGNATURE,
  deployAccount,
  accountPersonalSignHash,
  dummyR1Signature,
  encodeAccountInitCode,
  encodeAddAuthKey,
  encodeExecuteBatch,
  encodeR1UserOpSignature,
  encodeRemoveAuthKey,
  encodeSetData,
  getAccountData,
  getAuthKeys,
  getBootstrapOwner,
  signK1UserOpHash,
} from './account.js';
export { addressSchema, bytes32Schema, hexSchema, uintSchema } from './zod.js';
// ERC-4337 EntryPoint: UserOp construction + submission.
export {
  type PackedUserOperation,
  type UserOpGas,
  type UserOpJson,
  CANONICAL_ENTRY_POINT_V08,
  buildUserOp,
  getAccountNonce,
  getUserOpHash,
  handleOps,
  packU128LimbsToBytes32,
  packedUserOperationSchema,
  userOpToJson,
} from './entrypoint.js';
export {
  type ContractWriteResult,
  type ReceiptClient,
  type WriteOptions,
  maybeWaitForReceipt,
} from './write_receipt.js';
// Paymaster: signature-gated sponsorship.
export {
  encodeOxidePaymasterData,
  fundPaymaster,
  getPaymasterDeposit,
  getPaymasterHash,
  packPaymasterAndData,
} from './paymaster.js';
export { encodeDeployAndSweepForSubsidy, encodeSweep, encodeSweepForSubsidy, getSipaSweeps } from './sipa.js';
export type { SubsidizedDeployArgs, SweepArgs, SweepEvent } from './sipa.js';
export { readForwardingTableRow } from './forwarding_table.js';
export type { ForwardingTableRow } from './forwarding_table.js';
export {
  MULTICALL3_ADDRESS,
  buildSipaDeployAndSweepOperation,
  buildSipaSweepOperation,
  decodeSipaSweepOperation,
  decodeSubsidizedDeployAndSweep,
  encodeAggregate3,
  isContractDeployed,
} from './sipa_sweep_operation.js';
export type {
  Aggregate3Call,
  BuildSipaDeployAndSweepOperationParams,
  BuildSipaSweepOperationParams,
  SipaDeployCall,
  SipaSweepTarget,
  SubsidizedDeployAndSweep,
} from './sipa_sweep_operation.js';
export { classifyL1Operation } from './l1_operation_kind.js';
export type { L1OperationKind } from './l1_operation_kind.js';
export {
  encodeEscrowRecoverERC20,
  encodeEscrowRecoverETH,
  escrowERC20RecoveryDigest,
  escrowETHRecoveryDigest,
  findEscrowExecutionTx,
} from './escrow.js';
export * from './migration.js';
export * from './swap_on_withdraw.js';
export * from './cctp_bridge_on_withdraw.js';
export * from './across_bridge_on_withdraw.js';
export * from './user_op_intent.js';
export { AccountMetadataControllerAbi } from './artifacts.js';
export { UserOpSIPAAbi, UserOpSIPABytecode } from './artifacts.js';
export {
  EMPTY_SIGNED_TERMS,
  encodeDepositIntentData,
  encodeRegistrationRecord,
  decodeRegistrationRecord,
  encodeRegistrationIntentData,
  decodeRegistrationIntentData,
  encodeRegistrationProofs,
  encodeLegacyRegistrationProofs,
  decodeRegistrationProofs,
} from './intent.js';
export type { R1InstallArg, RegistrationIntent, RegistrationProofs, SignedTermsArg } from './intent.js';
export {
  R1_INSTALL_CALL_GAS_BASE,
  R1_INSTALL_CALL_GAS_PER_WORD,
  R1_INSTALL_GAS,
  R1_INSTALL_VERIFICATION_GAS,
  buildR1InstallUserOp,
  r1InstallCallGas,
} from './r1_install.js';
export type { R1InstallGas } from './r1_install.js';
export {
  MAINNET_DAI,
  MAINNET_CHAIN_ID,
  MAINNET_DEPOSIT_TOKENS,
  MAINNET_USDC,
  MAINNET_USDT,
  depositPayoutTokenFor,
  depositTokensFor,
} from './deposit_tokens.js';

export { deployUserOpSIPA } from './deploy/deploy_sipa_implementations.js';
export { USER_OP_SWEEP_FEE } from './deploy/deploy_forwarding_table.js';
