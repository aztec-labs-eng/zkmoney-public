// SPDX-License-Identifier: Apache-2.0
pragma solidity >=0.8.27;
import {Test} from "forge-std/Test.sol";
import {OxideConstants} from "@generated/OxideConstants.gen.sol";
import {NameRegistry} from "@periphery/NameRegistry.sol";
import {AccountMetadataRegistry} from "@periphery/AccountMetadataRegistry.sol";
import {RegistrationController} from "@periphery/RegistrationController.sol";
import {NamePortal} from "@periphery/NamePortal.sol";
import {INameRegistry} from "@periphery/interfaces/INameRegistry.sol";
import {IOxideAccountFactory} from "@periphery/interfaces/IOxideAccountFactory.sol";
import {SIPAFactory} from "@periphery/SIPAFactory.sol";
import {DepositSIPA} from "@periphery/DepositSIPA.sol";
import {RegistrationSIPA} from "@periphery/RegistrationSIPA.sol";
import {ForwardingTable} from "@periphery/ForwardingTable.sol";
import {ForwardingTableFixture, REGISTRATION_SWEEP_TIP} from "@test/helpers/ForwardingTableFixture.sol";
import {Resolver} from "@periphery/Resolver.sol";
import {DepositSubsidy} from "@periphery/DepositSubsidy.sol";
import {OperationExecutor} from "@periphery/OperationExecutor.sol";
import {IOperationExecutor} from "@periphery/interfaces/IOperationExecutor.sol";
import {PlainWithdrawalSubsidy} from "@periphery/PlainWithdrawalSubsidy.sol";
import {ProverSubsidy} from "@periphery/ProverSubsidy.sol";
import {PlainWithdrawalExecutor} from "@periphery/PlainWithdrawalExecutor.sol";
import {AggregatorV3Interface} from "@periphery/interfaces/AggregatorV3Interface.sol";
import {RecoveryCommitmentLib} from "@periphery/RecoveryCommitmentLib.sol";
import {OxidePortal} from "@core/OxidePortal.sol";
import {TeeRegistry} from "@core/TeeRegistry.sol";
import {IOxidePortal} from "@core/interfaces/IOxidePortal.sol";
import {IExecutor} from "@core/interfaces/IExecutor.sol";
import {TestERC20} from "@aztec/mock/TestERC20.sol";
import {IInbox} from "@aztec/core/interfaces/messagebridge/IInbox.sol";
import {IOutbox} from "@aztec/core/interfaces/messagebridge/IOutbox.sol";
import {IVerifier} from "@aztec/core/interfaces/IVerifier.sol";
import {DataStructures} from "@aztec/core/libraries/DataStructures.sol";
import {Hash} from "@aztec/core/libraries/crypto/Hash.sol";
import {IHaveVersion, IRegistry} from "@aztec/governance/interfaces/IRegistry.sol";
import {IERC20} from "@oz/token/ERC20/IERC20.sol";
import {IERC20 as IERC20OZ} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {MockCertManager} from "@test/fixtures/MockCertManager.sol";
import {MockV3Aggregator} from "@test/mocks/MockV3Aggregator.sol";
import {MockProofVerifier} from "@test/fixtures/MockProofVerifier.sol";
import {MockInbox} from "@test/fixtures/MockInbox.sol";
import {MockNitroValidator} from "@test/fixtures/MockNitroValidator.sol";
import {MockOutbox} from "@test/fixtures/MockOutbox.sol";
import {MockRegistry} from "@test/fixtures/MockRegistry.sol";
import {MockRollup} from "@test/fixtures/MockRollup.sol";

abstract contract OxidePortalBase is Test {
  bytes32 public pendingL2Token = L2_TOKEN;

  OxidePortal internal portal;
  NameRegistry internal nameRegistry;
  AccountMetadataRegistry internal metadataRegistry;
  RegistrationController internal registrationController;
  NamePortal internal namePortal;
  IOxideAccountFactory internal accountFactory;
  SIPAFactory internal sipaFactory;
  ForwardingTable internal forwardingTable;
  DepositSIPA internal depositSIPAImplementation;
  RegistrationSIPA internal registrationSIPAImplementation;
  Resolver internal resolver;
  DepositSubsidy internal depositSubsidy;
  OperationExecutor internal operationExecutor;
  AggregatorV3Interface internal ethUsdFeed;
  PlainWithdrawalSubsidy internal plainWithdrawalSubsidy;
  ProverSubsidy internal proverSubsidy;
  PlainWithdrawalExecutor internal plainWithdrawalExecutor;
  TestERC20 internal underlying;
  MockInbox internal inbox;
  IInbox internal wiredInbox;
  MockOutbox internal outbox;
  IOutbox internal wiredOutbox;
  MockRollup internal rollup;
  MockRegistry internal registry;
  MockProofVerifier internal frozenNotesRefundVerifier;
  MockProofVerifier internal frozenDepositsRefundVerifier;
  MockProofVerifier internal unprocessedDepositRefundVerifier;
  MockCertManager internal certManager;
  MockNitroValidator internal nitroValidator;
  TeeRegistry internal teeRegistry;

  bytes32 internal constant L2_TOKEN = bytes32(uint256(0xB12D6E));
  uint256 internal constant ROLLUP_VERSION = 7;
  bytes32 internal constant TEE_REGISTRY_L2_RECIPIENT = bytes32(uint256(0x4a12));
  uint256 internal constant DEFAULT_CHECKPOINT_NUMBER = 11;
  bytes32 internal constant DEFAULT_ARCHIVE_ROOT = bytes32(uint256(0xA11CE));

  uint128 internal constant TX_AMOUNT_CAP = 2583 ether;
  uint256 internal constant RATE = 1 ether;
  uint256 internal constant GLOBAL_LIMIT = 500_000 ether;

  address internal constant OWNER = address(0x0FFE);
  address internal constant USER = address(0xA11CE);
  address internal constant PROCESSOR = address(0x9120);

  address internal constant FEE_BENEFICIARY = address(0xD819);
  address internal constant TABLE_BENEFICIARY = address(0x7AB1E);
  address internal constant WITHDRAWAL_FEE_BENEFICIARY = address(0xFEEB);
  uint256 internal constant REGISTRATION_MIN = 9.5 ether;
  uint256 internal constant REGISTRATION_FEE = 5 ether;
  uint256 internal constant REGISTRATION_FUNDER_CUT = REGISTRATION_FEE - REGISTRATION_SWEEP_TIP;

  uint256 internal constant TEST_TEE_PK = 0xA11;
  address internal constant TEST_TEE_SIGNER = 0x563Bd9e11d18b6eA60c2f159F8D3062d30E8039e;

  bytes32 internal constant TEST_TEE_PUBLIC_KEY_X =
    bytes32(0xf079ac6591f2736317e9e0ab6a723e25e29950c7a02a66bc96c4ae68044f42f5);
  bytes32 internal constant TEST_TEE_PUBLIC_KEY_Y =
    bytes32(0xea87d1bfc99f43744acc3ca0214a1ef7490186d03d92456224981469c432dfc5);
  bytes internal constant TEST_TEE_PUBLIC_KEY =
    hex"f079ac6591f2736317e9e0ab6a723e25e29950c7a02a66bc96c4ae68044f42f5ea87d1bfc99f43744acc3ca0214a1ef7490186d03d92456224981469c432dfc5";
  bytes32 internal constant TEST_ENC_PUB_KEY_X =
    bytes32(0xee9569836aa098c9a8cd87b6f27437ab7736022da38902400371a286f0a667f5);
  bytes32 internal constant TEST_ENC_PUB_KEY_Y =
    bytes32(0x5d3b9c0e4f7a2bd14e96f8c7a25b3df9e8c0a162b574d3f80a91cb3a78e6f124);
  bytes internal constant TEST_TEE_PCR0 =
    hex"0102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f202122232425262728292a2b2c2d2e2f30";

  event Frozen(
    uint256 indexed checkpointNumber, uint256 indexed epochNumber, bytes32 archive, uint256 freezeCheckpointCount
  );
  event Deposit(bytes32 indexed recipientCommitment, uint256 amount, bytes32 key, uint256 index);
  event WithdrawalOrRefund(
    IExecutor.Flow indexed flow, bytes32 indexed nullifier, address indexed executor, uint256 executionAmount
  );
  event TipReleased(address indexed to, uint256 amount);

  address internal teeSigner;
  uint256 internal teePk;
  uint256 internal plainWithdrawalFee;

  struct WithdrawParams {
    address recipient;
    address tipRecipient;
    address executor;
    bytes32 userPayloadHash;
    uint256 amount;
    uint256 processorTip;
    uint256 proverTip;
    uint256 randomness;
    uint256 epochNumber;
    uint256 leafIndex;
    uint256 checkpointNumber;
    bytes32 archiveRoot;
    bytes32 withdrawalId;
  }

  function setUp() public virtual {
    underlying = new TestERC20("Test", "TST", address(this));
    rollup = new MockRollup();
    _setupOutbox();
    _setupInbox();
    registry = new MockRegistry();
    frozenNotesRefundVerifier = new MockProofVerifier();
    frozenDepositsRefundVerifier = new MockProofVerifier();
    unprocessedDepositRefundVerifier = new MockProofVerifier();
    certManager = new MockCertManager();
    nitroValidator = new MockNitroValidator();

    _setCheckpoint(2);
    rollup.setProvenCheckpointNumber(DEFAULT_CHECKPOINT_NUMBER);
    rollup.setInbox(wiredInbox);
    rollup.setOutbox(wiredOutbox);
    registry.setCanonicalRollup(IHaveVersion(address(rollup)));
    registry.setRollup(ROLLUP_VERSION, IHaveVersion(address(rollup)));

    accountFactory = _deployAccountFactory();
    IVerifier mockResolverVerifier = IVerifier(address(new MockProofVerifier()));
    nameRegistry = new NameRegistry(OWNER, OWNER);
    sipaFactory = new SIPAFactory(OWNER);
    metadataRegistry = new AccountMetadataRegistry(nameRegistry);
    namePortal = new NamePortal(INameRegistry(address(nameRegistry)), IRegistry(address(registry)), accountFactory);
    resolver = new Resolver(nameRegistry, sipaFactory, mockResolverVerifier);
    registrationController = new RegistrationController(
      INameRegistry(address(nameRegistry)),
      sipaFactory,
      accountFactory,
      namePortal,
      IERC20OZ(address(underlying)),
      REGISTRATION_MIN,
      REGISTRATION_FEE,
      FEE_BENEFICIARY
    );
    vm.startPrank(OWNER);
    nameRegistry.updateAccountMetadataRegistry(address(metadataRegistry));
    nameRegistry.updateResolver(address(resolver));
    nameRegistry.updateRegistrationController(address(registrationController));
    vm.stopPrank();
    nitroValidator.setCertManager(certManager);
    teeRegistry = new TeeRegistry(
      keccak256(TEST_TEE_PCR0),
      certManager,
      nitroValidator,
      IRegistry(address(registry)),
      ROLLUP_VERSION,
      TEE_REGISTRY_L2_RECIPIENT
    );
    portal = _buildPortal(address(underlying));
    forwardingTable = ForwardingTableFixture.deploy(OWNER, IOxidePortal(address(portal)), TABLE_BENEFICIARY);
    depositSIPAImplementation = new DepositSIPA();
    registrationSIPAImplementation = new RegistrationSIPA(INameRegistry(address(nameRegistry)));
    vm.startPrank(OWNER);
    sipaFactory.blessImplementation(address(depositSIPAImplementation));
    sipaFactory.blessImplementation(address(registrationSIPAImplementation));
    sipaFactory.blessTable(forwardingTable);
    vm.stopPrank();
    ethUsdFeed = AggregatorV3Interface(address(new MockV3Aggregator(8, 2500e8)));
    plainWithdrawalExecutor = new PlainWithdrawalExecutor(
      address(portal),
      plainWithdrawalFee,
      plainWithdrawalFee == 0 ? address(0) : WITHDRAWAL_FEE_BENEFICIARY,
      OWNER,
      ethUsdFeed
    );
    operationExecutor = new OperationExecutor();
    depositSubsidy = new DepositSubsidy(
      OWNER, address(portal), IOperationExecutor(address(operationExecutor)), ethUsdFeed, sipaFactory
    );
    plainWithdrawalSubsidy = plainWithdrawalExecutor.SUBSIDY();
    proverSubsidy = new ProverSubsidy(OWNER, address(portal));

    underlying.mint(USER, TX_AMOUNT_CAP * 10);
    vm.prank(USER);
    underlying.approve(address(portal), type(uint256).max);
  }

  function _buildPortal(address _underlying) internal returns (OxidePortal) {
    return new OxidePortal(
      teeRegistry,
      IERC20(_underlying),
      IRegistry(address(registry)),
      ROLLUP_VERSION,
      OxidePortal.RefundVerifiers({
        frozenNotes: IVerifier(address(frozenNotesRefundVerifier)),
        frozenDeposits: IVerifier(address(frozenDepositsRefundVerifier)),
        unprocessedDeposit: IVerifier(address(unprocessedDepositRefundVerifier))
      }),
      TX_AMOUNT_CAP,
      RATE,
      GLOBAL_LIMIT
    );
  }

  function _recoveryCommitment(string memory label) internal pure returns (bytes32) {
    return RecoveryCommitmentLib.deriveRecoveryCommitment(keccak256(bytes(label)), address(0));
  }

  function _deployAccountFactory() internal virtual returns (IOxideAccountFactory) {
    return IOxideAccountFactory(makeAddr("placeholderAccountFactory"));
  }

  function _setupOutbox() internal virtual {
    outbox = new MockOutbox();
    wiredOutbox = IOutbox(address(outbox));
  }

  function _setupInbox() internal virtual {
    inbox = new MockInbox();
    wiredInbox = IInbox(address(inbox));
  }

  modifier givenPortalIsFrozen() {
    _freeze();
    _;
  }

  modifier givenRollupIsNonCanonical() {
    _makeRollupNonCanonical();
    _;
  }

  modifier givenTeeIsRegistered(string memory) {
    teeSigner = TEST_TEE_SIGNER;
    teePk = TEST_TEE_PK;
    _registerSigner();
    _;
  }

  function _recordDeposit(bytes32 _messageHash, uint256 _messageLeafIndex) internal {
    inbox.primeNext(_messageHash, _messageLeafIndex);
    vm.prank(USER);
    portal.deposit(bytes32(uint256(0xD3905)), 10 ether);
  }

  function _freeze() internal {
    _freezePortal(portal);
  }

  function _freezePortal(OxidePortal _portal) internal {
    _makeRollupNonCanonical();
    _portal.freeze();
  }

  function _makeRollupNonCanonical() internal {
    registry.setCanonicalRollup(IHaveVersion(address(0xBEEF)));
  }

  function _registerSigner() internal {
    bytes32 userData =
      _registrationUserData(TEST_TEE_PUBLIC_KEY_X, TEST_TEE_PUBLIC_KEY_Y, TEST_ENC_PUB_KEY_X, TEST_ENC_PUB_KEY_Y);

    bytes memory attestationTbs = bytes.concat(TEST_TEE_PCR0, abi.encodePacked(userData));

    nitroValidator.setRegistrationPtrs(uint64(block.timestamp * 1000), 0, 48);
    teeRegistry.registerTee(
      attestationTbs, hex"1234", TEST_TEE_PUBLIC_KEY_X, TEST_TEE_PUBLIC_KEY_Y, TEST_ENC_PUB_KEY_X, TEST_ENC_PUB_KEY_Y
    );
  }

  function _registrationUserData(bytes32 _pubKeyX, bytes32 _pubKeyY, bytes32 _encPubKeyX, bytes32 _encPubKeyY)
    internal
    pure
    returns (bytes32)
  {
    return sha256(abi.encodePacked(bytes12("oxide-tee/v1"), _pubKeyX, _pubKeyY, _encPubKeyX, _encPubKeyY));
  }

  function _setCheckpoint(uint256 _epochNumber) internal {
    rollup.setCheckpoint(DEFAULT_CHECKPOINT_NUMBER, DEFAULT_ARCHIVE_ROOT, _epochNumber);
  }

  function _defaultWithdrawParams() internal view returns (WithdrawParams memory p) {
    p = WithdrawParams({
      recipient: USER,
      tipRecipient: PROCESSOR,
      executor: address(plainWithdrawalExecutor),
      userPayloadHash: 0x00933e6c511ad85168d59c39a333286a8fec3f69d5448bb2ba1d3582c9e39f30,
      amount: 75 ether,
      processorTip: 0,
      proverTip: 0,
      randomness: 0xDEC0DE,
      epochNumber: 9,
      leafIndex: 3,
      checkpointNumber: DEFAULT_CHECKPOINT_NUMBER,
      archiveRoot: DEFAULT_ARCHIVE_ROOT,
      withdrawalId: bytes32(uint256(0xDEADBEEF))
    });
  }

  function _contentHash(WithdrawParams memory p) internal pure returns (bytes32) {
    return Hash.sha256ToField(
      abi.encodeWithSignature(
        "withdraw(address,bytes32,uint256,uint256,uint256)",
        p.executor,
        p.userPayloadHash,
        p.amount,
        p.proverTip,
        p.randomness
      )
    );
  }

  function _messageHash(WithdrawParams memory p) internal view returns (bytes32) {
    DataStructures.L2ToL1Msg memory message = DataStructures.L2ToL1Msg({
      sender: DataStructures.L2Actor({actor: L2_TOKEN, version: ROLLUP_VERSION}),
      recipient: DataStructures.L1Actor({actor: address(portal), chainId: block.chainid}),
      content: _contentHash(p)
    });
    return Hash.sha256ToField(message);
  }

  function _finalDigest(WithdrawParams memory p) internal view returns (bytes32) {
    return _teeWithdrawalFinalDigest(p.archiveRoot, p.withdrawalId, _messageHash(p));
  }

  function _frozenNotesRefundFinalDigest(WithdrawParams memory p, bytes32[] memory _nullifiers)
    internal
    view
    returns (bytes32)
  {
    bytes32[] memory publicInputs = _frozenNotesRefundPublicInputs(p.executor, p.userPayloadHash, p.amount, _nullifiers);
    return _teeFrozenNotesRefundFinalDigest(publicInputs);
  }

  function _teeWithdrawalFinalDigest(bytes32 _archiveRoot, bytes32 _withdrawalId, bytes32 _withdrawalHash)
    internal
    view
    returns (bytes32)
  {
    return sha256(
      abi.encodePacked(
        OxideConstants.TEE_SIG_DOMAIN_WITHDRAWAL_FINALIZED,
        address(portal.TEE_REGISTRY()),
        _archiveRoot,
        _withdrawalId,
        _withdrawalHash
      )
    );
  }

  function _teeFrozenNotesRefundFinalDigest(bytes32[] memory _publicInputs) internal view returns (bytes32) {
    return sha256(
      abi.encodePacked(OxideConstants.TEE_SIG_DOMAIN_FROZEN_NOTES_REFUND, address(portal.TEE_REGISTRY()), _publicInputs)
    );
  }

  function _frozenDepositsRefundFinalDigest(WithdrawParams memory p, bytes32 _siloedNullifier)
    internal
    view
    returns (bytes32)
  {
    return _frozenDepositsRefundFinalDigest(p, _oneNullifier(_siloedNullifier));
  }

  function _frozenDepositsRefundFinalDigest(WithdrawParams memory p, bytes32[] memory _nullifiers)
    internal
    view
    returns (bytes32)
  {
    bytes32[] memory publicInputs =
      _frozenDepositsRefundPublicInputs(p.executor, p.userPayloadHash, p.amount, _nullifiers);
    return _teeFrozenDepositsRefundFinalDigest(publicInputs);
  }

  function _oneNullifier(bytes32 _nullifier) internal pure returns (bytes32[] memory nullifiers) {
    nullifiers = new bytes32[](1);
    nullifiers[0] = _nullifier;
  }

  function _teeFrozenDepositsRefundFinalDigest(bytes32[] memory _publicInputs) internal view returns (bytes32) {
    return sha256(abi.encodePacked(OxideConstants.TEE_SIG_DOMAIN_FROZEN_DEPOSITS_REFUND, _publicInputs));
  }

  function _content(WithdrawParams memory p) internal pure returns (IOxidePortal.WithdrawContent memory) {
    return IOxidePortal.WithdrawContent({
      executor: p.executor,
      userPayloadHash: p.userPayloadHash,
      amount: p.amount,
      proverTip: p.proverTip,
      randomness: p.randomness
    });
  }

  function _withdraw(WithdrawParams memory p, bytes32[] memory _path, bytes memory _signature) internal {
    _withdrawWithTipRecipient(p, _path, _signature, msg.sender);
  }

  function _withdrawWithTipRecipient(
    WithdrawParams memory p,
    bytes32[] memory _path,
    bytes memory _signature,
    address _tipRecipient
  ) internal {
    portal.withdraw(
      IOxidePortal.WithdrawArgs({
        content: _content(p),
        userPayload: _userPayload(p),
        relayerPayload: _relayerPayload(_tipRecipient),
        epochNumber: p.epochNumber,
        numCheckpointsInEpoch: 1,
        leafIndex: p.leafIndex,
        path: _path,
        checkpointNumber: p.checkpointNumber,
        withdrawalId: p.withdrawalId,
        teeSignature: _signature
      })
    );
  }

  function _withdrawWithCheckpoint(
    WithdrawParams memory p,
    bytes32[] memory _path,
    uint256 _checkpointNumber,
    bytes memory _signature
  ) internal {
    portal.withdraw(
      IOxidePortal.WithdrawArgs({
        content: _content(p),
        userPayload: _userPayload(p),
        relayerPayload: _relayerPayload(msg.sender),
        epochNumber: p.epochNumber,
        numCheckpointsInEpoch: 1,
        leafIndex: p.leafIndex,
        path: _path,
        checkpointNumber: _checkpointNumber,
        withdrawalId: p.withdrawalId,
        teeSignature: _signature
      })
    );
  }

  function _withdrawFrozen(
    WithdrawParams memory p,
    uint256 _numCheckpointsInEpoch,
    uint256 _leafIndex,
    bytes32[] memory _path,
    bytes memory _signature
  ) internal {
    portal.withdraw(
      IOxidePortal.WithdrawArgs({
        content: _content(p),
        userPayload: _userPayload(p),
        relayerPayload: _relayerPayload(msg.sender),
        epochNumber: p.epochNumber,
        numCheckpointsInEpoch: _numCheckpointsInEpoch,
        leafIndex: _leafIndex,
        path: _path,
        checkpointNumber: p.checkpointNumber,
        withdrawalId: p.withdrawalId,
        teeSignature: _signature
      })
    );
  }

  function _refundFrozenNotes(
    WithdrawParams memory p,
    bytes32[] memory _nullifiers,
    bytes memory _proof,
    bytes memory _signature
  ) internal {
    portal.refundFrozenNotes(
      IOxidePortal.RefundFrozenNotesArgs({
        executor: p.executor,
        userPayload: _userPayload(p),
        relayerPayload: _relayerPayload(p.tipRecipient),
        amount: p.amount,
        nullifiers: _nullifiers,
        proof: _proof,
        teeSignature: _signature
      })
    );
  }

  function _refundFrozenDeposits(
    WithdrawParams memory p,
    bytes32 _siloedNullifier,
    bytes memory _proof,
    bytes memory _signature
  ) internal {
    _refundFrozenDeposits(p, _oneNullifier(_siloedNullifier), _proof, _signature);
  }

  function _refundFrozenDeposits(
    WithdrawParams memory p,
    bytes32[] memory _nullifiers,
    bytes memory _proof,
    bytes memory _signature
  ) internal {
    portal.refundFrozenDeposits(
      IOxidePortal.RefundFrozenDepositsArgs({
        executor: p.executor,
        userPayload: _userPayload(p),
        relayerPayload: _relayerPayload(p.tipRecipient),
        amount: p.amount,
        nullifiers: _nullifiers,
        proof: _proof,
        teeSignature: _signature
      })
    );
  }

  function _refundUnprocessedDeposit(
    WithdrawParams memory p,
    bytes32 _siloedNullifier,
    bytes32 _unprocessedMsgHash,
    uint256 _messageLeafIndex,
    bytes memory _proof,
    bytes memory _signature
  ) internal {
    portal.refundUnprocessedDeposit(
      IOxidePortal.RefundUnprocessedDepositArgs({
        executor: p.executor,
        userPayload: _userPayload(p),
        relayerPayload: _relayerPayload(p.tipRecipient),
        amount: p.amount,
        siloedNullifier: _siloedNullifier,
        messageHash: _unprocessedMsgHash,
        messageLeafIndex: _messageLeafIndex,
        proof: _proof,
        teeSignature: _signature
      })
    );
  }

  function _frozenNotesRefundPublicInputs(
    address _executor,
    bytes32 _userPayloadHash,
    uint256 _amount,
    bytes32[] memory _nullifiers
  ) internal view returns (bytes32[] memory) {
    bytes32[] memory publicInputs = new bytes32[](OxideConstants.FROZEN_NOTES_REFUND_PUBLIC_INPUT_COUNT);
    publicInputs[0] = bytes32(block.chainid);
    publicInputs[1] = bytes32(portal.ROLLUP_VERSION());
    publicInputs[2] = bytes32(uint256(uint160(address(portal))));
    publicInputs[3] = portal.L2_TOKEN();
    publicInputs[4] = portal.$freezeArchive();
    publicInputs[5] = bytes32(_amount);
    publicInputs[6] = bytes32(uint256(uint160(_executor)));
    publicInputs[7] = _userPayloadHash;

    for (uint256 i = 0; i < _nullifiers.length; i++) {
      publicInputs[i + 8] = _nullifiers[i];
    }

    return publicInputs;
  }

  function _frozenDepositsRefundPublicInputs(
    address _executor,
    bytes32 _userPayloadHash,
    uint256 _amount,
    bytes32 _siloedNullifier
  ) internal view returns (bytes32[] memory) {
    return _frozenDepositsRefundPublicInputs(_executor, _userPayloadHash, _amount, _oneNullifier(_siloedNullifier));
  }

  function _frozenDepositsRefundPublicInputs(
    address _executor,
    bytes32 _userPayloadHash,
    uint256 _amount,
    bytes32[] memory _nullifiers
  ) internal view returns (bytes32[] memory) {
    bytes32[] memory publicInputs = new bytes32[](OxideConstants.FROZEN_DEPOSITS_REFUND_PUBLIC_INPUT_COUNT);
    publicInputs[0] = bytes32(block.chainid);
    publicInputs[1] = bytes32(portal.ROLLUP_VERSION());
    publicInputs[2] = bytes32(uint256(uint160(address(portal))));
    publicInputs[3] = portal.$freezeArchive();
    publicInputs[4] = bytes32(_amount);
    publicInputs[5] = bytes32(uint256(uint160(_executor)));
    publicInputs[6] = _userPayloadHash;

    for (uint256 i = 0; i < _nullifiers.length; i++) {
      publicInputs[i + 7] = _nullifiers[i];
    }

    return publicInputs;
  }

  function _unprocessedDepositRefundPublicInputs(
    address _executor,
    bytes32 _userPayloadHash,
    uint256 _amount,
    bytes32 _unprocessedMsgHash,
    uint256 _messageLeafIndex,
    bytes32 _siloedNullifier
  ) internal view returns (bytes32[] memory) {
    bytes32[] memory publicInputs = new bytes32[](OxideConstants.UNPROCESSED_DEPOSIT_REFUND_PUBLIC_INPUT_COUNT);
    publicInputs[0] = bytes32(block.chainid);
    publicInputs[1] = bytes32(portal.ROLLUP_VERSION());
    publicInputs[2] = bytes32(uint256(uint160(address(portal))));
    publicInputs[3] = portal.$freezeArchive();
    publicInputs[4] = bytes32(_amount);
    publicInputs[5] = bytes32(uint256(uint160(_executor)));
    publicInputs[6] = _userPayloadHash;
    publicInputs[7] = _unprocessedMsgHash;
    publicInputs[8] = bytes32(_messageLeafIndex);
    publicInputs[9] = _siloedNullifier;
    return publicInputs;
  }

  function _unprocessedDepositRefundFinalDigest(
    WithdrawParams memory p,
    bytes32 _unprocessedMsgHash,
    uint256 _messageLeafIndex,
    bytes32 _siloedNullifier
  ) internal view returns (bytes32) {
    bytes32[] memory publicInputs = _unprocessedDepositRefundPublicInputs(
      p.executor, p.userPayloadHash, p.amount, _unprocessedMsgHash, _messageLeafIndex, _siloedNullifier
    );
    return _teeUnprocessedDepositRefundFinalDigest(publicInputs);
  }

  function _teeUnprocessedDepositRefundFinalDigest(bytes32[] memory _publicInputs) internal view returns (bytes32) {
    return sha256(abi.encodePacked(OxideConstants.TEE_SIG_DOMAIN_UNPROCESSED_DEPOSIT_REFUND, _publicInputs));
  }

  function _signTee(uint256 _pk, bytes32 _digest) internal pure returns (bytes memory) {
    (uint8 v, bytes32 r, bytes32 s) = vm.sign(_pk, _digest);
    return abi.encodePacked(r, s, v);
  }

  function _dummyPath() internal pure returns (bytes32[] memory path) {
    path = new bytes32[](4);
    path[0] = bytes32(uint256(0x1111));
    path[1] = bytes32(uint256(0x2222));
    path[2] = bytes32(uint256(0x3333));
    path[3] = bytes32(uint256(0x4444));
  }

  function _pathOfLength(uint256 _length) internal pure returns (bytes32[] memory path) {
    path = new bytes32[](_length);
    for (uint256 i = 0; i < _length; i++) {
      path[i] = keccak256(abi.encode("sibling", i));
    }
  }

  function _userPayload(WithdrawParams memory p) internal pure returns (bytes memory) {
    return abi.encode(p.recipient, p.processorTip);
  }

  function _relayerPayload(address _tipRecipient) internal pure returns (bytes memory) {
    return abi.encodePacked(_tipRecipient);
  }

  function _syncPayloadHash(WithdrawParams memory p) internal pure {
    p.userPayloadHash = Hash.sha256ToField(_userPayload(p));
  }
}
