// SPDX-License-Identifier: Apache-2.0
pragma solidity >=0.8.27;
import {Test} from "forge-std/Test.sol";

import {TestERC20} from "@aztec/mock/TestERC20.sol";
import {Clones} from "@oz/proxy/Clones.sol";
import {IERC20} from "@oz/token/ERC20/IERC20.sol";
import {WebAuthn} from "@openzeppelin/contracts/utils/cryptography/WebAuthn.sol";
import {Base64} from "@openzeppelin/contracts/utils/Base64.sol";

import {SIPABase} from "@periphery/SIPABase.sol";
import {RecoveryCommitmentLib} from "@periphery/RecoveryCommitmentLib.sol";
import {OxideAccount} from "@periphery/OxideAccount.sol";
import {OxideAccountFactory} from "@periphery/OxideAccountFactory.sol";
import {DepositSIPA, DEPOSIT_FEE} from "@periphery/DepositSIPA.sol";
import {IOxidePortal} from "@core/interfaces/IOxidePortal.sol";
import {Errors} from "@periphery/Errors.sol";
import {DAI, USDC, USDT, THREE_POOL} from "@periphery/ThreePoolLib.sol";
import {StablecoinMocks} from "@test/helpers/StablecoinMocks.sol";
import {MockCurve3Pool} from "@test/mocks/MockCurve3Pool.sol";
import {MintableToken} from "@test/mocks/MintableToken.sol";

contract MockDepositPortal {
  IERC20 public immutable UNDERLYING;
  uint256 public immutable ROLLUP_VERSION;

  uint256 public nextIndex;

  bytes32 public lastRecipientCommitment;
  uint256 public lastAmount;
  uint256 public escrowed;

  constructor(IERC20 _token, uint256 _version) {
    UNDERLYING = _token;
    ROLLUP_VERSION = _version;
  }

  function deposit(bytes32 recipientCommitment, uint256 amount)
    external
    returns (bytes32 key, uint256 index, uint256 creditedAmount)
  {
    UNDERLYING.transferFrom(msg.sender, address(this), amount);
    escrowed += amount;
    lastRecipientCommitment = recipientCommitment;
    lastAmount = amount;
    index = nextIndex++;
    key = keccak256(abi.encode(recipientCommitment, amount, index));
    creditedAmount = amount;
  }
}

contract FeeRoutingSIPA is SIPABase {
  constructor(IOxidePortal portal_, uint256 fee) SIPABase(portal_, fee) {}

  function INTENT() external pure override returns (Intent) {
    return Intent.Deposit;
  }

  function _execute(address token, bytes calldata intentData, bytes calldata)
    internal
    pure
    override
    returns (Routing memory)
  {
    (bytes32 recipientCommitment, address feeRecipient, uint256 fee) =
      abi.decode(intentData, (bytes32, address, uint256));
    return Routing({token: token, feeRecipient: feeRecipient, fee: fee, remainderRecipient: recipientCommitment});
  }
}

contract DepositSIPATest is Test {
  uint256 internal constant ROLLUP_VERSION = 7;
  bytes32 internal constant RECIPIENT_HASH = keccak256("recipient");
  uint256 internal constant DEPOSIT_AMOUNT = 1000e18;
  bytes32 internal constant SHARED_SECRET_SALT = keccak256("shared-secret-salt");
  uint256 internal constant AUTH_KEY_INDEX = 0;

  uint256 internal constant P256_N = 0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551;
  bytes1 internal constant AUTH_FLAGS_UP_UV = WebAuthn.AUTH_DATA_FLAGS_UP | WebAuthn.AUTH_DATA_FLAGS_UV;
  address internal constant ENTRY_POINT = 0x4337084D9E255Ff0702461CF8895CE9E3b5Ff108;
  bytes32 internal constant EIP712_DOMAIN_TYPEHASH =
    keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");
  bytes32 internal constant PERSONAL_SIGN_TYPEHASH = keccak256("PersonalSign(bytes prefixed)");

  TestERC20 internal token;
  MockDepositPortal internal portal;
  DepositSIPA internal implementation;
  uint256 internal fee = DEPOSIT_FEE;

  address internal relayer = makeAddr("relayer");
  address internal depositSubsidy = makeAddr("depositSubsidy");

  OxideAccountFactory internal accountFactory;
  OxideAccount internal account;
  address internal bootstrap;
  uint256 internal bootstrapKey;
  uint256 internal p256Key;

  function setUp() public {
    token = new TestERC20("Test", "TST", address(this));
    portal = new MockDepositPortal(IERC20(address(token)), ROLLUP_VERSION);
    implementation = new DepositSIPA(IOxidePortal(address(portal)), fee);

    accountFactory = new OxideAccountFactory();
    (bootstrap, bootstrapKey) = makeAddrAndKey("bootstrap");
    account = OxideAccount(payable(accountFactory.deploy(bootstrap)));
    p256Key = uint256(keccak256("p256-key")) % P256_N;
  }

  function _installPasskey() internal {
    (uint256 x, uint256 y) = vm.publicKeyP256(p256Key);
    vm.prank(ENTRY_POINT);
    account.addAuthKey(OxideAccount.R1Key({qx: bytes32(x), qy: bytes32(y)}), "passkey:alice");
  }

  function _domainSeparator(address verifyingContract) internal view returns (bytes32) {
    return keccak256(
      abi.encode(EIP712_DOMAIN_TYPEHASH, keccak256("OxideAccount"), keccak256("1"), block.chainid, verifyingContract)
    );
  }

  function _personalSignDigest(bytes32 hash) internal view returns (bytes32) {
    bytes32 structHash = keccak256(abi.encode(PERSONAL_SIGN_TYPEHASH, hash));
    return keccak256(abi.encodePacked("\x19\x01", _domainSeparator(address(account)), structHash));
  }

  function _k1Signature(uint256 privateKey, bytes32 digest) internal pure returns (bytes memory) {
    (uint8 v, bytes32 r, bytes32 s) = vm.sign(privateKey, digest);
    return abi.encodePacked(r, s, v);
  }

  function _r1Signature(uint256 privateKey, bytes32 challenge) internal pure returns (bytes memory) {
    WebAuthn.WebAuthnAuth memory auth;
    auth.clientDataJSON =
      string.concat('{"type":"webauthn.get","challenge":"', Base64.encodeURL(abi.encodePacked(challenge)), '"}');
    auth.typeIndex = 1;
    auth.challengeIndex = 23;
    auth.authenticatorData = abi.encodePacked(keccak256("rpIdHash"), AUTH_FLAGS_UP_UV, bytes4(0));

    bytes32 messageHash = sha256(abi.encodePacked(auth.authenticatorData, sha256(bytes(auth.clientDataJSON))));
    (bytes32 r, bytes32 s) = vm.signP256(privateKey, messageHash);
    if (uint256(s) > P256_N / 2) {
      s = bytes32(P256_N - uint256(s));
    }
    auth.r = r;
    auth.s = s;

    bytes memory encodedAuth =
      abi.encode(auth.r, auth.s, auth.challengeIndex, auth.typeIndex, auth.authenticatorData, auth.clientDataJSON);
    return abi.encodePacked(bytes32(AUTH_KEY_INDEX), encodedAuth);
  }

  function _erc20RecoveryDigest(address deposit, address target, address tkn, bytes32 nonce)
    internal
    view
    returns (bytes32)
  {
    return keccak256(abi.encode(deposit, block.chainid, target, tkn, nonce));
  }

  function _ethRecoveryDigest(address deposit, address target, bytes32 nonce) internal view returns (bytes32) {
    return keccak256(abi.encode(deposit, block.chainid, target, nonce));
  }

  function _intentData(bytes32 recipientCommitment) internal pure returns (bytes memory) {
    return abi.encode(recipientCommitment);
  }

  function _deploy(bytes32 recoveryCommitment) internal returns (DepositSIPA) {
    return _deployWithArgs(recoveryCommitment, ROLLUP_VERSION, true);
  }

  function _deployForAccount() internal returns (DepositSIPA) {
    return _deployWithArgs(
      RecoveryCommitmentLib.deriveRecoveryCommitment(SHARED_SECRET_SALT, address(account)), ROLLUP_VERSION, true
    );
  }

  function _deployWithArgs(bytes32 recoveryCommitment, uint256 rollupVersion, bool resweepable)
    internal
    returns (DepositSIPA)
  {
    bytes memory args = abi.encode(
      SIPABase.Args({
        intentHash: keccak256(_intentData(RECIPIENT_HASH)),
        recoveryCommitment: recoveryCommitment,
        rollupVersion: rollupVersion,
        resweepable: resweepable
      })
    );
    return DepositSIPA(Clones.cloneWithImmutableArgs(address(implementation), args));
  }

  function _sweep(DepositSIPA deposit) internal {
    deposit.sweep(address(token), relayer, _intentData(RECIPIENT_HASH), "");
  }

  function test_depositSweepIsEquivalentToPlainForward() public {
    DepositSIPA deposit = _deploy(keccak256("recovery"));
    token.mint(address(deposit), DEPOSIT_AMOUNT);

    vm.expectEmit(true, true, true, true, address(deposit));
    emit SIPABase.Sweep(0, DEPOSIT_AMOUNT - fee);

    _sweep(deposit);

    assertEq(portal.escrowed(), DEPOSIT_AMOUNT - fee);
    assertEq(portal.lastRecipientCommitment(), RECIPIENT_HASH);
    assertEq(portal.lastAmount(), DEPOSIT_AMOUNT - fee);
    assertEq(token.balanceOf(relayer), fee, "the sweep pays the relayer the implementation's fee");
    assertEq(token.balanceOf(address(deposit)), 0);
  }

  function test_sweepRevertsOnIntentDataMismatch() public {
    DepositSIPA deposit = _deploy(keccak256("recovery"));
    token.mint(address(deposit), DEPOSIT_AMOUNT);

    vm.expectRevert(Errors.SIPA__IntentDataMismatch.selector);
    deposit.sweep(address(token), relayer, _intentData(keccak256("other")), "");
  }

  function test_sweepRevertsOnEmptyBalance() public {
    DepositSIPA deposit = _deploy(keccak256("recovery"));
    vm.expectRevert(Errors.SIPA__EmptyBalance.selector);
    _sweep(deposit);
  }

  function test_resweepableSweepsTwice() public {
    DepositSIPA deposit = _deploy(keccak256("recovery"));
    token.mint(address(deposit), DEPOSIT_AMOUNT);
    _sweep(deposit);

    token.mint(address(deposit), DEPOSIT_AMOUNT);
    _sweep(deposit);

    assertEq(portal.escrowed(), 2 * (DEPOSIT_AMOUNT - fee));
    assertFalse(deposit.swept());
  }

  function test_nonResweepableSecondSweepReverts() public {
    DepositSIPA deposit = _deployWithArgs(keccak256("recovery"), ROLLUP_VERSION, false);
    token.mint(address(deposit), DEPOSIT_AMOUNT);
    _sweep(deposit);
    assertTrue(deposit.swept());

    token.mint(address(deposit), DEPOSIT_AMOUNT);
    vm.expectRevert(Errors.SIPA__AlreadySwept.selector);
    _sweep(deposit);
  }

  function test_nonResweepableRecoverAfterSweep() public {
    DepositSIPA deposit = _deployWithArgs(
      RecoveryCommitmentLib.deriveRecoveryCommitment(SHARED_SECRET_SALT, address(account)), ROLLUP_VERSION, false
    );
    token.mint(address(deposit), DEPOSIT_AMOUNT);
    _sweep(deposit);

    token.mint(address(deposit), DEPOSIT_AMOUNT);
    address target = makeAddr("target");
    bytes32 nonce = keccak256("nonce-1");
    bytes memory sig = _k1Signature(
      bootstrapKey, _personalSignDigest(_erc20RecoveryDigest(address(deposit), target, address(token), nonce))
    );
    deposit.recoverERC20(SHARED_SECRET_SALT, address(account), sig, target, address(token), nonce);

    assertEq(token.balanceOf(target), DEPOSIT_AMOUNT);
  }

  function test_sweepRevertsOnRollupVersionMismatch() public {
    DepositSIPA deposit = _deployWithArgs(keccak256("recovery"), ROLLUP_VERSION + 1, true);
    token.mint(address(deposit), DEPOSIT_AMOUNT);

    vm.expectRevert(Errors.SIPA__RollupVersionMismatch.selector);
    _sweep(deposit);
  }

  function test_plumbingIsTheImplementationsNotTheClones() public {
    DepositSIPA deposit = _deploy(keccak256("recovery"));
    assertEq(address(deposit.portal()), address(portal));
    assertEq(deposit.depositFee(), fee);
    assertEq(address(implementation.PORTAL()), address(portal));
    assertEq(address(implementation.UNDERLYING()), address(token));
    assertEq(implementation.DEPOSIT_FEE(), fee);
  }

  function test_sweepRevertsWhenTheRoutedFeeCannotCoverTheRelayerCut() public {
    uint256 relayerCut = 100;
    FeeRoutingSIPA feeImplementation = new FeeRoutingSIPA(IOxidePortal(address(portal)), relayerCut);
    bytes memory intentData = abi.encode(RECIPIENT_HASH, makeAddr("funder"), relayerCut - 1);
    SIPABase sipa = SIPABase(
      Clones.cloneWithImmutableArgs(
        address(feeImplementation),
        abi.encode(
          SIPABase.Args({
            intentHash: keccak256(intentData),
            recoveryCommitment: keccak256("recovery"),
            rollupVersion: ROLLUP_VERSION,
            resweepable: true
          })
        )
      )
    );
    token.mint(address(sipa), DEPOSIT_AMOUNT);

    vm.expectRevert(abi.encodeWithSelector(Errors.SIPA__FeeBelowDepositFee.selector, relayerCut - 1, relayerCut));
    sipa.sweep(address(token), relayer, intentData, "");
  }

  function test_implementationRejectsZeroPlumbing() public {
    vm.expectRevert(Errors.SIPA__ZeroPortal.selector);
    new DepositSIPA(IOxidePortal(address(0)), fee);

    vm.expectRevert(Errors.SIPA__ZeroDepositFee.selector);
    new DepositSIPA(IOxidePortal(address(portal)), 0);
  }

  function test_implementationRevertsAsNotClone() public {
    vm.expectRevert(Errors.SIPA__NotClone.selector);
    implementation.sweep(address(token), relayer, _intentData(RECIPIENT_HASH), "");

    vm.expectRevert(Errors.SIPA__NotClone.selector);
    implementation.intentHash();
  }

  function test_recoverERC20TransfersBalanceToTarget() public {
    DepositSIPA deposit = _deployForAccount();
    token.mint(address(deposit), DEPOSIT_AMOUNT);

    address target = makeAddr("target");
    bytes32 nonce = keccak256("nonce-1");
    bytes memory sig = _k1Signature(
      bootstrapKey, _personalSignDigest(_erc20RecoveryDigest(address(deposit), target, address(token), nonce))
    );

    vm.expectEmit(true, true, true, true, address(deposit));
    emit SIPABase.Recovered(address(token), target, DEPOSIT_AMOUNT);
    deposit.recoverERC20(SHARED_SECRET_SALT, address(account), sig, target, address(token), nonce);

    assertEq(token.balanceOf(target), DEPOSIT_AMOUNT);
    assertEq(token.balanceOf(address(deposit)), 0);
    assertTrue(deposit.usedNonces(nonce));
  }

  function test_recoverERC20SucceedsWithPasskey() public {
    _installPasskey();
    DepositSIPA deposit = _deployForAccount();
    token.mint(address(deposit), DEPOSIT_AMOUNT);

    address target = makeAddr("target");
    bytes32 nonce = keccak256("nonce-1");
    bytes memory sig =
      _r1Signature(p256Key, _personalSignDigest(_erc20RecoveryDigest(address(deposit), target, address(token), nonce)));

    deposit.recoverERC20(SHARED_SECRET_SALT, address(account), sig, target, address(token), nonce);

    assertEq(token.balanceOf(target), DEPOSIT_AMOUNT);
  }

  function test_recoverERC20RevertsOnBootstrapSigOncePasskeyInstalled() public {
    _installPasskey();
    DepositSIPA deposit = _deployForAccount();
    token.mint(address(deposit), DEPOSIT_AMOUNT);

    address target = makeAddr("target");
    bytes32 nonce = keccak256("nonce-1");
    bytes memory sig = _k1Signature(
      bootstrapKey, _personalSignDigest(_erc20RecoveryDigest(address(deposit), target, address(token), nonce))
    );

    vm.expectRevert(Errors.SIPA__InvalidSignature.selector);
    deposit.recoverERC20(SHARED_SECRET_SALT, address(account), sig, target, address(token), nonce);
  }

  function test_recoverERC20RevertsOnWrongAccount() public {
    DepositSIPA deposit = _deployForAccount();
    token.mint(address(deposit), DEPOSIT_AMOUNT);

    OxideAccount other = OxideAccount(payable(accountFactory.deploy(makeAddr("otherBootstrap"))));
    address target = makeAddr("target");
    bytes32 nonce = keccak256("nonce-1");
    bytes memory sig = _k1Signature(
      bootstrapKey, _personalSignDigest(_erc20RecoveryDigest(address(deposit), target, address(token), nonce))
    );

    vm.expectRevert(Errors.SIPA__RecoveryCommitmentMismatch.selector);
    deposit.recoverERC20(SHARED_SECRET_SALT, address(other), sig, target, address(token), nonce);
  }

  function test_recoverERC20RevertsOnWrongSalt() public {
    DepositSIPA deposit = _deployForAccount();
    token.mint(address(deposit), DEPOSIT_AMOUNT);

    address target = makeAddr("target");
    bytes32 nonce = keccak256("nonce-1");
    bytes memory sig = _k1Signature(
      bootstrapKey, _personalSignDigest(_erc20RecoveryDigest(address(deposit), target, address(token), nonce))
    );

    vm.expectRevert(Errors.SIPA__RecoveryCommitmentMismatch.selector);
    deposit.recoverERC20(keccak256("wrong-salt"), address(account), sig, target, address(token), nonce);
  }

  function test_recoverERC20RevertsOnReusedNonce() public {
    DepositSIPA deposit = _deployForAccount();
    token.mint(address(deposit), DEPOSIT_AMOUNT);

    address target = makeAddr("target");
    bytes32 nonce = keccak256("nonce-1");
    bytes memory sig = _k1Signature(
      bootstrapKey, _personalSignDigest(_erc20RecoveryDigest(address(deposit), target, address(token), nonce))
    );
    deposit.recoverERC20(SHARED_SECRET_SALT, address(account), sig, target, address(token), nonce);

    token.mint(address(deposit), DEPOSIT_AMOUNT);
    vm.expectRevert(Errors.SIPA__NonceAlreadyUsed.selector);
    deposit.recoverERC20(SHARED_SECRET_SALT, address(account), sig, target, address(token), nonce);
  }

  function test_recoverERC20RevertsOnWrongSigner() public {
    DepositSIPA deposit = _deployForAccount();
    token.mint(address(deposit), DEPOSIT_AMOUNT);

    (, uint256 attackerPk) = makeAddrAndKey("attacker");
    address target = makeAddr("target");
    bytes32 nonce = keccak256("nonce-1");
    bytes memory sig = _k1Signature(
      attackerPk, _personalSignDigest(_erc20RecoveryDigest(address(deposit), target, address(token), nonce))
    );

    vm.expectRevert(Errors.SIPA__InvalidSignature.selector);
    deposit.recoverERC20(SHARED_SECRET_SALT, address(account), sig, target, address(token), nonce);
  }

  function test_recoverERC20RevertsOnRedirectedTarget() public {
    DepositSIPA deposit = _deployForAccount();
    token.mint(address(deposit), DEPOSIT_AMOUNT);

    address target = makeAddr("target");
    bytes32 nonce = keccak256("nonce-1");
    bytes memory sig = _k1Signature(
      bootstrapKey, _personalSignDigest(_erc20RecoveryDigest(address(deposit), target, address(token), nonce))
    );

    vm.expectRevert(Errors.SIPA__InvalidSignature.selector);
    deposit.recoverERC20(SHARED_SECRET_SALT, address(account), sig, makeAddr("attacker"), address(token), nonce);
  }

  function test_recoverETHTransfersBalanceToTarget() public {
    _installPasskey();
    DepositSIPA deposit = _deployForAccount();
    vm.deal(address(deposit), DEPOSIT_AMOUNT);

    address target = makeAddr("target");
    bytes32 nonce = keccak256("nonce-1");
    bytes memory sig = _r1Signature(p256Key, _personalSignDigest(_ethRecoveryDigest(address(deposit), target, nonce)));

    vm.expectEmit(true, true, true, true, address(deposit));
    emit SIPABase.Recovered(address(0), target, DEPOSIT_AMOUNT);
    deposit.recoverETH(SHARED_SECRET_SALT, address(account), sig, target, nonce);

    assertEq(target.balance, DEPOSIT_AMOUNT);
    assertEq(address(deposit).balance, 0);
    assertTrue(deposit.usedNonces(nonce));
  }

  function test_recoverETHRevertsOnEmptyBalance() public {
    DepositSIPA deposit = _deployForAccount();

    address target = makeAddr("target");
    bytes32 nonce = keccak256("nonce-1");
    bytes memory sig =
      _k1Signature(bootstrapKey, _personalSignDigest(_ethRecoveryDigest(address(deposit), target, nonce)));

    vm.expectRevert(Errors.SIPA__EmptyBalance.selector);
    deposit.recoverETH(SHARED_SECRET_SALT, address(account), sig, target, nonce);
  }

  function test_recoverETHRevertsOnReusedNonce() public {
    DepositSIPA deposit = _deployForAccount();
    vm.deal(address(deposit), DEPOSIT_AMOUNT);

    address target = makeAddr("target");
    bytes32 nonce = keccak256("nonce-1");
    bytes memory sig =
      _k1Signature(bootstrapKey, _personalSignDigest(_ethRecoveryDigest(address(deposit), target, nonce)));
    deposit.recoverETH(SHARED_SECRET_SALT, address(account), sig, target, nonce);

    vm.deal(address(deposit), DEPOSIT_AMOUNT);
    vm.expectRevert(Errors.SIPA__NonceAlreadyUsed.selector);
    deposit.recoverETH(SHARED_SECRET_SALT, address(account), sig, target, nonce);
  }

  function test_recoverETHRevertsOnWrongSigner() public {
    DepositSIPA deposit = _deployForAccount();
    vm.deal(address(deposit), DEPOSIT_AMOUNT);

    (, uint256 attackerPk) = makeAddrAndKey("attacker");
    address target = makeAddr("target");
    bytes32 nonce = keccak256("nonce-1");
    bytes memory sig =
      _k1Signature(attackerPk, _personalSignDigest(_ethRecoveryDigest(address(deposit), target, nonce)));

    vm.expectRevert(Errors.SIPA__InvalidSignature.selector);
    deposit.recoverETH(SHARED_SECRET_SALT, address(account), sig, target, nonce);
  }
}

contract DepositSIPAStableSettleTest is Test {
  uint256 internal constant ROLLUP_VERSION = 7;
  bytes32 internal constant RECIPIENT_HASH = keccak256("recipient");
  uint256 internal constant AMOUNT_6DEC = 1000e6;
  uint256 internal constant STABLE_TO_DAI_DECIMAL_SCALE = 1e12;
  uint256 internal constant PAR_RATE = STABLE_TO_DAI_DECIMAL_SCALE * 1e18;

  MockCurve3Pool internal threePool;
  MockDepositPortal internal daiPortal;
  DepositSIPA internal implementation;

  address internal relayer = makeAddr("relayer");

  function setUp() public {
    vm.chainId(1);
    threePool = StablecoinMocks.install();
    threePool.setRate(address(DAI), PAR_RATE);
    MintableToken(address(DAI)).mint(address(THREE_POOL), 1_000_000e18);

    daiPortal = new MockDepositPortal(DAI, ROLLUP_VERSION);
    implementation = new DepositSIPA(IOxidePortal(address(daiPortal)), DEPOSIT_FEE);
  }

  function test_usdcSweepSwapsIntoDaiBeforeTheDeposit() public {
    DepositSIPA sipa = _sipaOf(implementation);
    MintableToken(address(USDC)).mint(address(sipa), AMOUNT_6DEC);

    vm.expectEmit(true, true, true, true, address(sipa));
    emit SIPABase.Sweep(0, AMOUNT_6DEC * STABLE_TO_DAI_DECIMAL_SCALE - DEPOSIT_FEE);
    sipa.sweep(address(USDC), relayer, _intent(), "");

    assertEq(DAI.balanceOf(relayer), DEPOSIT_FEE, "the relayer must be paid in DAI");
    assertEq(daiPortal.escrowed(), AMOUNT_6DEC * STABLE_TO_DAI_DECIMAL_SCALE - DEPOSIT_FEE);
    assertEq(threePool.lastI(), 1);
    assertEq(threePool.lastJ(), 0);
    assertEq(threePool.lastDx(), AMOUNT_6DEC);
    assertEq(threePool.lastMinDy(), (AMOUNT_6DEC * STABLE_TO_DAI_DECIMAL_SCALE * 9900) / 10_000);
    assertEq(USDC.balanceOf(address(sipa)), 0);
    assertEq(DAI.balanceOf(address(sipa)), 0);
  }

  function test_usdtSweepSwapsIntoDaiBeforeTheDeposit() public {
    DepositSIPA sipa = _sipaOf(implementation);
    MintableToken(address(USDT)).mint(address(sipa), AMOUNT_6DEC);

    sipa.sweep(address(USDT), relayer, _intent(), "");

    assertEq(daiPortal.escrowed(), AMOUNT_6DEC * STABLE_TO_DAI_DECIMAL_SCALE - DEPOSIT_FEE);
    assertEq(threePool.lastI(), 2);
    assertEq(USDT.balanceOf(address(sipa)), 0);
  }

  function test_idleDaiIsSweptAlongWithTheSwapOutput() public {
    DepositSIPA sipa = _sipaOf(implementation);
    uint256 idleDai = 5e18;
    MintableToken(address(DAI)).mint(address(sipa), idleDai);
    MintableToken(address(USDC)).mint(address(sipa), AMOUNT_6DEC);

    sipa.sweep(address(USDC), relayer, _intent(), "");

    assertEq(daiPortal.escrowed(), AMOUNT_6DEC * STABLE_TO_DAI_DECIMAL_SCALE + idleDai - DEPOSIT_FEE);
    assertEq(DAI.balanceOf(address(sipa)), 0, "the sweep settles the whole balance in the settled token");
  }

  function test_swapBelowTheMinOutReverts() public {
    threePool.setRate(address(DAI), (PAR_RATE * 9899) / 10_000);
    DepositSIPA sipa = _sipaOf(implementation);
    MintableToken(address(USDC)).mint(address(sipa), AMOUNT_6DEC);

    vm.expectRevert("Exchange resulted in fewer coins than expected");
    sipa.sweep(address(USDC), relayer, _intent(), "");
  }

  function test_emptyStableBalanceReverts() public {
    DepositSIPA sipa = _sipaOf(implementation);
    vm.expectRevert(Errors.SIPA__EmptyBalance.selector);
    sipa.sweep(address(USDC), relayer, _intent(), "");
  }

  function test_tokenOutsideTheRouteIsPassedThroughAndRejectedByTheSIPA() public {
    DepositSIPA sipa = _sipaOf(implementation);
    TestERC20 other = new TestERC20("Other", "OTH", address(this));
    other.mint(address(sipa), AMOUNT_6DEC);
    MintableToken(address(DAI)).mint(address(sipa), 100e18);

    vm.expectRevert(abi.encodeWithSelector(Errors.SIPA__TokenNotPortalUnderlying.selector, address(other)));
    sipa.sweep(address(other), relayer, _intent(), "");
    assertEq(threePool.callCount(), 0);
    assertEq(DAI.balanceOf(address(sipa)), 100e18, "the stray token must not bridge the SIPA's underlying");
    assertEq(daiPortal.escrowed(), 0);
  }

  function test_offMainnetUsdcIsPassedThroughUnchanged() public {
    vm.chainId(31_337);
    DepositSIPA sipa = _sipaOf(implementation);
    MintableToken(address(USDC)).mint(address(sipa), AMOUNT_6DEC);

    vm.expectRevert(abi.encodeWithSelector(Errors.SIPA__TokenNotPortalUnderlying.selector, address(USDC)));
    sipa.sweep(address(USDC), relayer, _intent(), "");
    assertEq(threePool.callCount(), 0);
  }

  function test_offMainnetAPortalForUsdcTakesTheDirectPath() public {
    vm.chainId(31_337);
    MockDepositPortal usdcPortal = new MockDepositPortal(USDC, ROLLUP_VERSION);
    DepositSIPA sipa = _sipaOf(new DepositSIPA(IOxidePortal(address(usdcPortal)), 25e4));
    MintableToken(address(USDC)).mint(address(sipa), AMOUNT_6DEC);

    sipa.sweep(address(USDC), relayer, _intent(), "");

    assertEq(usdcPortal.escrowed(), AMOUNT_6DEC - 25e4);
    assertEq(USDC.balanceOf(relayer), 25e4);
    assertEq(threePool.callCount(), 0);
  }

  function _intent() internal pure returns (bytes memory) {
    return abi.encode(RECIPIENT_HASH);
  }

  function _sipaOf(DepositSIPA _implementation) internal returns (DepositSIPA) {
    bytes memory args = abi.encode(
      SIPABase.Args({
        intentHash: keccak256(_intent()),
        recoveryCommitment: keccak256("recovery"),
        rollupVersion: ROLLUP_VERSION,
        resweepable: true
      })
    );
    return DepositSIPA(Clones.cloneWithImmutableArgs(address(_implementation), args));
  }
}
