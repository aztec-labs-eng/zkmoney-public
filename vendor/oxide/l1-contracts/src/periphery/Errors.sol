// SPDX-License-Identifier: Apache-2.0
pragma solidity >=0.8.27;

library Errors {
  error MetadataUpdate__Resweepable();
  error MetadataUpdate__WrongRegistry();
  error MetadataUpdate__WrongNamePortal();
  error MetadataUpdate__StaleRecord();
  error MetadataUpdate__InvalidConsent();
  error OperationExecutor__InsufficientPayout(uint256 payout, uint256 minPayout);

  error PlainWithdrawalExecutor__UnauthorizedCaller();
  error PlainWithdrawalExecutor__InvalidPortal();
  error PlainWithdrawalExecutor__InvalidUserPayload();
  error PlainWithdrawalExecutor__InvalidRelayerPayload();
  error PlainWithdrawalExecutor__ZeroRecipient();
  error PlainWithdrawalExecutor__ZeroTipRecipient();
  error PlainWithdrawalExecutor__RelayerTipExceedsAmount();

  error OxideAccount__InvalidR1Key();
  error OxideAccount__AuthKeyIndexOutOfBounds();
  error OxideAccount__CannotRemoveLastKey();
  error OxideAccount__AuthKeyMismatch();
  error OxideAccount__NotClone();

  error OxideAccountFactory__InvalidBootstrapOwner();

  error RegistrationRouter__ZeroAmount();
  error RegistrationRouter__ZeroNameRegistry();
  error RegistrationSIPA__ZeroNameRegistry();
  error RegistrationRouter__NoImplementationForPortal(address portal);

  error SIPAFactory__ZeroImplementation();
  error SIPAFactory__PortalIntentAlreadyPointed(address portal, uint8 intent, address implementation);
  error SIPAFactory__RecoveryCommitmentTooLarge(bytes32 recoveryCommitment);

  error Resolver__UnsupportedResolverFunction(bytes4 selector);
  error Resolver__NoImplementationForPortal(address portal);
  error Resolver__MalformedResolveData();
  error Resolver__RollupVersionMismatch(uint256 resolverOperatorVersion, uint256 userVersion);
  error Resolver__InvalidProof();
  error Resolver__StaleProof(uint32 proofDay, uint32 currentDay);
  error Resolver__UserRecordMismatch();
  error Resolver__ResolverOperatorRecordMismatch();
  error Resolver__SIPAMismatch(address expected, address actual);
  error Resolver__UserNotFound();

  error NameRegistry__EmptyNameHash();
  error NameRegistry__ZeroOwner();
  error NameRegistry__NameAlreadyRegistered();
  error NameRegistry__OwnerAlreadyHasName();
  error NameRegistry__NameNotFound();
  error NameRegistry__DomainAuthExpired();
  error NameRegistry__DomainNonceAlreadyUsed();
  error NameRegistry__InvalidDomainSignature();
  error NameRegistry__CallerNotRegistrationController(address caller);
  error NameRegistry__ZeroRegistrationController();
  error NameRegistry__ZeroResolver();
  error NameRegistry__ZeroAccountMetadataRegistry();

  error AccountMetadataRegistry__ZeroNameRegistry();
  error AccountMetadataRegistry__Unauthorized(address caller, address user);
  error AccountMetadataRegistry__UserRecordNotFound(address user);
  error AccountMetadataRegistry__ResolverOperatorNotFound(address resolverOperator);
  error AccountMetadataRegistry__InvalidPublicKey();
  error AccountMetadataRegistry__EmptyResolverOperatorURL();
  error AccountMetadataRegistry__EmptyOxidePortal();
  error AccountMetadataRegistry__EmptyResolverOperatorL2Address();

  error RegistrationController__ZeroNameRegistry();
  error RegistrationController__ZeroSIPAFactory();
  error RegistrationController__ZeroAccountFactory();
  error RegistrationController__ZeroFeeToken();
  error RegistrationController__ZeroNamePortal();
  error RegistrationController__InvalidConsent(address owner);
  error RegistrationController__AccountMismatch(address account, address owner);
  error RegistrationController__ZeroBeneficiary();
  error RegistrationController__NotDomainOwner();
  error RegistrationController__CallerNotSIPA(address caller);
  error RegistrationController__RegistrationDataMismatch();
  error RegistrationController__FeeTokenMismatch(address token, address feeToken);
  error RegistrationController__BalanceBelowFloor(uint256 balance, uint256 required);
  error RegistrationController__FeeMismatch(uint256 fee, uint256 expected);
  error RegistrationController__FeeBelowRelayerFee(uint256 fee, uint256 relayerFee);
  error RegistrationController__BeneficiaryNotAllowlisted(address beneficiary);
  error RegistrationController__TermsExpired();
  error RegistrationController__TermsNonceAlreadyUsed();
  error RegistrationController__InvalidTermsSignature();
  error RegistrationController__R1KeyNotInstalled();

  error NamePortal__ZeroNameRegistry();
  error NamePortal__ZeroAztecRegistry();
  error NamePortal__ZeroRecipient();
  error NamePortal__NameNotFound(address user);

  error SIPA__EmptyBalance();
  error SIPA__RollupVersionMismatch();
  error SIPA__ZeroPortal();
  error SIPA__ZeroDepositFee();
  error SIPA__NonceAlreadyUsed();
  error SIPA__InvalidSignature();
  error SIPA__RecoveryCommitmentMismatch();
  error SIPA__EthTransferFailed();
  error SIPA__NotClone();
  error SIPA__AlreadySwept();
  error SIPA__IntentDataMismatch();
  error SIPA__FeeBelowDepositFee(uint256 fee, uint256 depositFee);
  error SIPA__SweepBelowDepositFee(uint256 balance, uint256 depositFee);
  error SIPA__TokenNotPortalUnderlying(address token);

  error DepositSubsidy__NotASIPA(address sipa);
  error DepositSubsidy__SIPABoundToAnotherPortal(address sipa);
  error DepositSubsidy__FeedWithoutCode();
  error DepositSubsidy__ProfitAboveFeeFloor(uint128 approximateMinProfit, uint128 minFee);

  error WithdrawalSubsidy__UnauthorizedExecutor();
  error WithdrawalSubsidy__ZeroTipRecipient();
  error WithdrawalSubsidy__FeedWithoutCode();
  error WithdrawalSubsidy__ZeroExecutor();

  error ProverSubsidy__UnauthorizedPortal();

  error FPCFunder__ZeroBeneficiary();
  error FPCFunder__BalanceBelowMinimum(uint256 balance, uint256 minimum);
  error FPCFunder__AlreadyFundedThisBlock();
  error FPCFunder__NothingToDeposit();
  error FPCFunder__FeedWithoutCode();

  error EthUsdMinOut__InvalidPrice(int256 answer);
  error EthUsdMinOut__StalePrice(uint256 updatedAt);
}
