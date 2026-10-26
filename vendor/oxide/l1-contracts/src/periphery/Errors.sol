// SPDX-License-Identifier: Apache-2.0
pragma solidity >=0.8.27;

library Errors {
  error UserOpSIPA__Resweepable();
  error UserOpSIPA__PreconditionFailed();
  error UserOpSIPA__PostconditionFailed();
  error UserOpSIPA__ConditionReverted();
  error UserOpSIPA__ConditionTargetHasNoCode();
  error UserOpSIPA__NonceNotReached();
  error OperationExecutor__InsufficientPayout(uint256 payout, uint256 minPayout);

  error PlainWithdrawalExecutor__InvalidUserPayload();
  error PlainWithdrawalExecutor__InvalidRelayerPayload();
  error PlainWithdrawalExecutor__ZeroRecipient();
  error PlainWithdrawalExecutor__ZeroTipRecipient();
  error PlainWithdrawalExecutor__RelayerTipExceedsAmount();

  error FeeChargingExecutorBase__UnauthorizedCaller();
  error FeeChargingExecutorBase__InvalidPortal();
  error FeeChargingExecutorBase__ZeroBeneficiary();
  error FeeChargingExecutorBase__AmountNotAboveFee();

  error MultiStepExecutor__InvalidRelayerPayload();
  error MultiStepExecutor__ZeroTransferRecipient();
  error MultiStepExecutor__ZeroRemainderRecipient();
  error MultiStepExecutor__NotThisExecutor();
  error MultiStepExecutor__ZeroRecoveryRecipient();

  error CoreAdapter__ZeroRecipient();
  error MakerPsmAdapter__InsufficientOutput(uint256 amountOut, uint256 minOut);

  error OxideAccount__InvalidR1Key();
  error OxideAccount__AuthKeyIndexOutOfBounds();
  error OxideAccount__CannotRemoveLastKey();
  error OxideAccount__AuthKeyMismatch();
  error OxideAccount__NotClone();

  error OxideAccountFactory__InvalidBootstrapOwner();

  error RegistrationRouter__ZeroAmount();
  error RegistrationRouter__ZeroNameRegistry();
  error RegistrationSIPA__ZeroNameRegistry();
  error RegistrationSIPA__BalanceBelowBeneficiaryFee(uint256 balance, uint256 beneficiaryFee);
  error RegistrationRouter__TableNotApproved(address table);
  error RegistrationRouter__NoRegistrationImplementation();

  error SIPAFactory__ZeroImplementation();
  error SIPAFactory__ZeroTable();
  error SIPAFactory__RecoveryCommitmentTooLarge(bytes32 recoveryCommitment);

  error ForwardingTable__ZeroPortal();
  error ForwardingTable__NoIntents();
  error ForwardingTable__NoneIntent();
  error ForwardingTable__IntentAlreadyListed(address token, uint8 intent);
  error ForwardingTable__TokenAlreadyListed(address token);
  error ForwardingTable__ZeroSweepTip();
  error ForwardingTable__ZeroBeneficiary();
  error ForwardingTable__TokenNotListed(address token);
  error ForwardingTable__IntentNotListed(address token, uint8 intent);
  error ForwardingTable__TokenNotPortalUnderlying(address token, address underlying);
  error ForwardingTable__RollupVersionMismatch(uint256 portalVersion, uint256 tableVersion);

  error Resolver__UnsupportedResolverFunction(bytes4 selector);
  error Resolver__TableNotApproved(address table);
  error Resolver__NoDepositImplementation();
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
  error RegistrationController__NotRegistryOwner();
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
  error NamePortal__ZeroAccountFactory();
  error NamePortal__NotFactoryAccount(address user);

  error SIPA__EmptyBalance();
  error SIPA__RollupVersionMismatch();
  error SIPA__NonceAlreadyUsed();
  error SIPA__InvalidSignature();
  error SIPA__RecoveryCommitmentMismatch();
  error SIPA__EthTransferFailed();
  error SIPA__NotClone();
  error SIPA__AlreadySwept();
  error SIPA__IntentDataMismatch();
  error SIPA__FeeBelowSweepTip(uint256 fee, uint256 sweepTip);
  error SIPA__SweepBelowCharges(uint256 balance, uint256 charges);

  error DepositSubsidy__NotASIPA(address sipa);
  error DepositSubsidy__SIPABoundToAnotherPortal(address sipa);
  error DepositSubsidy__FeedWithoutCode();
  error DepositSubsidy__UnexpectedFeedDecimals(uint8 decimals);
  error DepositSubsidy__NoImplementationForIntent(uint8 intent);
  error DepositSubsidy__TableNotApproved(address table);

  error PlainWithdrawalSubsidy__UnauthorizedExecutor();
  error PlainWithdrawalSubsidy__ZeroTipRecipient();
  error PlainWithdrawalSubsidy__FeedWithoutCode();
  error PlainWithdrawalSubsidy__UnexpectedFeedDecimals(uint8 decimals);
  error PlainWithdrawalSubsidy__ZeroExecutor();

  error MigrationExecutor__PortalWithoutCode(address portal);
  error MigrationExecutor__SamePortal();
  error MigrationExecutor__UnderlyingMismatch();
  error MigrationExecutor__UnauthorizedCaller();
  error MigrationExecutor__InvalidUserPayload();
  error MigrationExecutor__InvalidRelayerPayload();
  error MigrationExecutor__ZeroRecipientCommitment();
  error MigrationExecutor__RelayerTipExceedsAmount();
  error MigrationExecutor__ZeroTipRecipient();
  error MigrationExecutor__NothingToMigrate();
  error MigrationExecutor__TipNotInPayoutToken();

  error MigrationSubsidy__NotOperationExecutor(address caller);
  error MigrationSubsidy__UnauthorizedExecutor();
  error MigrationSubsidy__FeedWithoutCode();
  error MigrationSubsidy__UnexpectedFeedDecimals(uint8 decimals);
  error MigrationSubsidy__ZeroExecutor();

  error ProverSubsidy__UnauthorizedPortal();

  error FirstProverProofSubmitter__CheckpointAlreadyProven(uint256 checkpoint, uint256 proven);

  error FPCFunder__ZeroBeneficiary();
  error FPCFunder__BalanceBelowMinimum(uint256 balance, uint256 minimum);
  error FPCFunder__AlreadyFundedThisBlock();
  error FPCFunder__NothingToDeposit();
  error FPCFunder__FeedWithoutCode();

  error FeePool__WethWithoutCode();
  error FeePool__ZeroSpender();
  error FeePool__ActiveUntilNotInFuture(uint64 activeUntil);
  error FeePool__ZeroPeriod();
  error FeePool__RefillBelowOneWeiPerSecond(uint192 amountPerPeriod, uint64 period);
  error FeePool__ZeroIdleTimeout();
  error FeePool__IdleFromNotBeforeActiveUntil(uint64 idleFrom, uint64 activeUntil);
  error FeePool__NotALiveSpender(address spender);
  error FeePool__AmountAboveAvailable(uint256 amount, uint256 available);
  error FeePool__SpenderNotListed(address spender);
  error FeePool__SpenderAlreadyListed(address spender);
  error FeePool__SpenderNotReleasable(address spender);

  error EthUsdMinOut__InvalidPrice(int256 answer);
  error EthUsdMinOut__StalePrice(uint256 updatedAt);
}
