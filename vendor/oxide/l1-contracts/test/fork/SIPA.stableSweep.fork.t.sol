// SPDX-License-Identifier: Apache-2.0
pragma solidity >=0.8.27;

import {DepositSIPA} from "@periphery/DepositSIPA.sol";
import {SIPABase} from "@periphery/SIPABase.sol";
import {DAI, USDC, USDT, THREE_POOL} from "@periphery/ThreePoolLib.sol";
import {DepositSubsidy} from "@periphery/DepositSubsidy.sol";
import {RegistrationController} from "@periphery/RegistrationController.sol";
import {INameRegistry} from "@periphery/interfaces/INameRegistry.sol";
import {SignedTerms} from "@periphery/interfaces/IRegistrationController.sol";
import {IOxidePortal} from "@core/interfaces/IOxidePortal.sol";
import {OxidePortal} from "@core/OxidePortal.sol";
import {IERC20} from "@oz/token/ERC20/IERC20.sol";
import {IERC20 as IERC20OZ} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@oz/token/ERC20/utils/SafeERC20.sol";
import {TestERC20} from "@aztec/mock/TestERC20.sol";

import {MainnetForkFixture} from "@test/fork/MainnetForkFixture.sol";
import {OxidePortalBase} from "@test/core/OxidePortalBase.t.sol";
import {RegistrationTestBase} from "@test/periphery/registration/RegistrationTestBase.sol";
import {ISIPA} from "@periphery/interfaces/ISIPA.sol";
import {IOxideAccountFactory} from "@periphery/interfaces/IOxideAccountFactory.sol";
import {Errors} from "@periphery/Errors.sol";
import {IForwardingTable} from "@periphery/interfaces/IForwardingTable.sol";
import {
  ForwardingTableFixture,
  DEPOSIT_SWEEP_TIP,
  REGISTRATION_SWEEP_TIP
} from "@test/helpers/ForwardingTableFixture.sol";
import {RelayerTransaction} from "@test/periphery/RelayerTransaction.sol";
import {Intents} from "@periphery/Intent.sol";

contract SIPAStableSweepForkTest is MainnetForkFixture, RegistrationTestBase {
  using SafeERC20 for IERC20;

  uint256 internal constant AMOUNT_6DEC = 2500e6;
  uint256 internal constant AMOUNT_18DEC = 2500e18;
  uint128 internal constant USDC_SWEEP_TIP = 25e4;

  uint256 internal constant REGISTRATION_QUOTE_6DEC = 15e6;
  uint256 internal constant REGISTRATION_QUOTE_18DEC = 15e18;

  address internal donationHolder = makeAddr("donationHolder");
  uint256 internal sipaNonce;
  bytes32 internal constant RECIPIENT = keccak256("swap-recipient");

  OxidePortal internal daiPortal;
  uint256 internal fee = DEPOSIT_SWEEP_TIP;

  function setUp() public override(OxidePortalBase, RegistrationTestBase) {
    _selectMainnetFork();
    RegistrationTestBase.setUp();

    daiPortal = _buildPortal(address(DAI));
    forwardingTable = ForwardingTableFixture.deploy(OWNER, IOxidePortal(address(daiPortal)), TABLE_BENEFICIARY);
    vm.startPrank(OWNER);
    sipaFactory.blessTable(forwardingTable);
    vm.stopPrank();

    registrationController = new RegistrationController(
      INameRegistry(address(nameRegistry)),
      sipaFactory,
      accountFactory,
      namePortal,
      IERC20OZ(address(DAI)),
      REGISTRATION_MIN,
      REGISTRATION_FEE,
      FEE_BENEFICIARY
    );
    _setController(address(registrationController));
  }

  function _deployAccountFactory()
    internal
    override(OxidePortalBase, RegistrationTestBase)
    returns (IOxideAccountFactory)
  {
    return RegistrationTestBase._deployAccountFactory();
  }

  function test_GivenUsdc_WhenDeposited_ThenSwappedAmountMinusFeeForwarded() external {
    uint256 threePoolUsdcBefore = USDC.balanceOf(address(THREE_POOL));

    _sweep(_sipa(), USDC, AMOUNT_6DEC);
    uint256 forwardedAmount = DAI.balanceOf(address(daiPortal));

    assertGt(forwardedAmount + fee, 2450e18);
    assertLt(forwardedAmount + fee, 2550e18);
    assertEq(DAI.balanceOf(relayer), fee);
    assertEq(USDC.balanceOf(relayer), 0);
    assertEq(USDC.balanceOf(address(THREE_POOL)) - threePoolUsdcBefore, AMOUNT_6DEC);
    assertEq(USDC.balanceOf(address(daiPortal)), 0);
  }

  function test_GivenUsdt_WhenDeposited_ThenRoutesThroughThreePool() external {
    _sweep(_sipa(), USDT, AMOUNT_6DEC);
    uint256 forwardedAmount = DAI.balanceOf(address(daiPortal));

    assertGt(forwardedAmount + fee, 2450e18);
    assertLt(forwardedAmount + fee, 2550e18);
    assertEq(DAI.balanceOf(relayer), fee);
    assertEq(USDT.balanceOf(address(daiPortal)), 0);
  }

  function test_GivenDonatedDai_WhenUsdtDeposited_ThenDonationIsNotForwarded() external {
    uint256 donation = 1_000_000e18;
    deal(address(DAI), donationHolder, donation);

    _sweep(_sipa(), USDT, AMOUNT_6DEC);
    uint256 forwardedAmount = DAI.balanceOf(address(daiPortal));

    assertGt(forwardedAmount + fee, 2450e18);
    assertLt(forwardedAmount + fee, 2550e18);
    assertEq(DAI.balanceOf(donationHolder), donation);
  }

  function test_GivenIdleDaiInTheSipa_WhenUsdcDeposited_ThenItIsSweptAlong() external {
    DepositSIPA sipa = _sipa();
    uint256 idle = 100e18;
    deal(address(DAI), address(sipa), idle);

    _sweep(sipa, USDC, AMOUNT_6DEC / 2);
    uint256 forwardedAmount = DAI.balanceOf(address(daiPortal));

    assertGt(forwardedAmount + fee, 1225e18 + idle);
    assertLt(forwardedAmount + fee, 1275e18 + idle);
    assertEq(DAI.balanceOf(address(sipa)), 0, "the sweep settles the whole balance in the settled token");
  }

  function test_GivenSwapOutputBelowMinOut_WhenDeposited_ThenReverts() external {
    _frontRunThreePool();

    DepositSIPA sipa = _sipa();
    deal(address(USDC), address(sipa), AMOUNT_6DEC);
    vm.expectRevert("Exchange resulted in fewer coins than expected");
    sipa.sweep(address(USDC), relayer, _depositIntent(), "");
  }

  function test_GivenSwapOutputBelowMinOut_WhenRegistered_ThenReverts() external {
    _frontRunThreePool();

    (bytes memory data, address sipa, bytes memory proofs) = _prepareRegistration("minOut.usdc");
    deal(address(USDC), sipa, REGISTRATION_QUOTE_6DEC);
    vm.expectRevert("Exchange resulted in fewer coins than expected");
    SIPABase(sipa).sweep(address(USDC), relayer, data, proofs);
  }

  function test_GivenSwapOutputBelowFee_WhenDeposited_ThenReverts() external {
    DepositSIPA sipa = _sipa();
    deal(address(USDC), address(sipa), 2e5);

    vm.expectPartialRevert(Errors.SIPA__SweepBelowCharges.selector);
    sipa.sweep(address(USDC), relayer, _depositIntent(), "");
  }

  function test_GivenTokenWithoutARow_WhenDeposited_ThenReverts() external {
    DepositSIPA sipa = _sipa();
    TestERC20 other = new TestERC20("Other", "OTH", address(this));
    other.mint(address(sipa), AMOUNT_6DEC);

    vm.expectRevert(abi.encodeWithSelector(Errors.ForwardingTable__TokenNotListed.selector, address(other)));
    sipa.sweep(address(other), relayer, _depositIntent(), "");
  }

  function test_GivenNonMainnetChain_WhenUsdcDeposited_ThenReverts() external {
    DepositSIPA sipa = _sipa();
    deal(address(USDC), address(sipa), AMOUNT_6DEC);
    vm.chainId(31_337);

    vm.expectRevert(abi.encodeWithSelector(Errors.ForwardingTable__TokenNotListed.selector, address(USDC)));
    sipa.sweep(address(USDC), relayer, _depositIntent(), "");
  }

  function test_GivenNonMainnetChainWithAUsdcRow_WhenDeposited_ThenDirectPathWins() external {
    OxidePortal usdcPortal = _listUsdc();
    uint256 threePoolUsdcBefore = USDC.balanceOf(address(THREE_POOL));
    vm.chainId(31_337);

    _sweep(_sipa(), USDC, AMOUNT_6DEC);

    assertEq(USDC.balanceOf(address(usdcPortal)), AMOUNT_6DEC - USDC_SWEEP_TIP);
    assertEq(USDC.balanceOf(address(THREE_POOL)), threePoolUsdcBefore);
    assertEq(DAI.balanceOf(address(daiPortal)), 0);
  }

  function test_GivenAUsdcRow_WhenDepositedOnMainnet_ThenTheSwapSettlesInDai() external {
    OxidePortal usdcPortal = _listUsdc();

    _sweep(_sipa(), USDC, AMOUNT_6DEC);

    assertEq(USDC.balanceOf(address(usdcPortal)), 0);
    assertGt(DAI.balanceOf(address(daiPortal)) + fee, 2450e18);
  }

  function test_HardcodedCoinIndicesMatchMainnetPools() external view {
    assertEq(THREE_POOL.coins(0), address(DAI));
    assertEq(THREE_POOL.coins(1), address(USDC));
    assertEq(THREE_POOL.coins(2), address(USDT));
  }

  function test_GivenTheQuoteInUsdc_WhenRegistered_ThenTheNameIsPaidForInDai() external {
    _assertQuoteRegisters(USDC, REGISTRATION_QUOTE_6DEC, "quote.usdc");
  }

  function test_GivenTheQuoteInUsdt_WhenRegistered_ThenTheNameIsPaidForInDai() external {
    _assertQuoteRegisters(USDT, REGISTRATION_QUOTE_6DEC, "quote.usdt");
  }

  function test_GivenTheQuoteInDai_WhenRegistered_ThenThePathIsExact() external {
    (bytes32 nameHash, address owner) = _register(DAI, REGISTRATION_QUOTE_18DEC, "quote.dai", address(0));

    assertEq(nameRegistry.ownerOf(nameHash), owner);
    assertEq(DAI.balanceOf(FEE_BENEFICIARY), REGISTRATION_FEE - REGISTRATION_SWEEP_TIP);
    assertEq(DAI.balanceOf(relayer), REGISTRATION_SWEEP_TIP);
    assertEq(DAI.balanceOf(address(daiPortal)), REGISTRATION_QUOTE_18DEC - REGISTRATION_FEE);
  }

  function test_GivenUsdcUnderTheFloor_WhenRegistered_ThenReverts() external {
    uint256 underTheFloor = 14e6;
    (bytes memory data, address sipa, bytes memory proofs) = _prepareRegistration("under.usdc");
    deal(address(USDC), sipa, underTheFloor);

    vm.expectPartialRevert(Errors.RegistrationController__BalanceBelowFloor.selector);
    SIPABase(sipa).sweep(address(USDC), relayer, data, proofs);
  }

  function test_GivenSignedTermsWithSwapHeadroom_WhenFundedInUsdc_ThenRegisters() external {
    uint256 funded6Dec = 20e6;
    uint256 funded18Dec = 20e18;
    uint256 signedMin = (funded18Dec * 9900) / 10_000 - REGISTRATION_FEE;
    (, uint256 key) = makeAddrAndKey("terms.usdc");
    address owner = _ownerOf(key);
    bytes32 nameHash = keccak256("terms.usdc");
    bytes memory data = _registrationData(nameHash, owner);
    SIPABase sipa = _deployRegistrationSIPA(data);
    deal(address(USDC), address(sipa), funded6Dec);
    SignedTerms memory terms =
      _signedTerms(nameHash, owner, REGISTRATION_FEE, signedMin, nextNonce++, block.timestamp + 1 days);
    bytes memory proofs = _regProofs(
      vm.addr(key),
      _consentSig(key, data),
      _domainAuth(nameHash, owner, nextNonce++, block.timestamp + 1 days),
      terms,
      _r1Install(key, owner)
    );

    sipa.sweep(address(USDC), relayer, data, proofs);

    assertEq(nameRegistry.ownerOf(nameHash), owner);
    assertGe(DAI.balanceOf(address(daiPortal)), signedMin);
  }

  function _assertQuoteRegisters(IERC20 _token, uint256 _amount, string memory _salt) internal {
    (bytes32 nameHash, address owner) = _register(_token, _amount, _salt, address(0));

    assertEq(nameRegistry.ownerOf(nameHash), owner);
    assertEq(DAI.balanceOf(FEE_BENEFICIARY), REGISTRATION_FEE - REGISTRATION_SWEEP_TIP, "the funder is paid in DAI");
    assertEq(DAI.balanceOf(relayer), REGISTRATION_SWEEP_TIP, "the relayer is paid in DAI");
    uint256 bridged = DAI.balanceOf(address(daiPortal));
    assertGe(bridged, (REGISTRATION_QUOTE_18DEC * 9900) / 10_000 - REGISTRATION_FEE, "the min-out bounds the loss");
    assertLe(bridged, REGISTRATION_QUOTE_18DEC - REGISTRATION_FEE, "the swap cannot mint DAI");
    assertGe(bridged, REGISTRATION_MIN, "the bridged remainder never drops under the schedule minimum");
    assertEq(_token.balanceOf(FEE_BENEFICIARY), 0);
    assertEq(_token.balanceOf(relayer), 0);
  }

  function _prepareRegistration(string memory _salt)
    internal
    returns (bytes memory data, address sipa, bytes memory proofs)
  {
    (, uint256 key) = makeAddrAndKey(_salt);
    address owner = _ownerOf(key);
    bytes32 nameHash = keccak256(bytes(_salt));
    data = _registrationData(nameHash, owner);
    sipa = address(_deployRegistrationSIPA(data));
    proofs = _regProofs(
      vm.addr(key),
      _consentSig(key, data),
      _domainAuth(nameHash, owner, nextNonce++, block.timestamp + 1 days),
      _noTerms(),
      _r1Install(key, owner)
    );
  }

  function _register(IERC20 _token, uint256 _amount, string memory _salt, address _sm)
    internal
    returns (bytes32 nameHash, address owner)
  {
    (, uint256 key) = makeAddrAndKey(_salt);
    owner = _ownerOf(key);
    nameHash = keccak256(bytes(_salt));
    (bytes memory data, address sipa, bytes memory proofs) = _prepareRegistration(_salt);
    deal(address(_token), sipa, _amount);
    if (_sm == address(0)) {
      SIPABase(sipa).sweep(address(_token), relayer, data, proofs);
    } else {
      RelayerTransaction.send(
        relayer,
        DepositSubsidy(_sm),
        abi.encodeCall(
          DepositSubsidy.sweepForSubsidy, (ISIPA(sipa), address(_token), address(operationExecutor), data, proofs)
        )
      );
    }
  }

  function _frontRunThreePool() internal {
    address attacker = makeAddr("attacker");
    uint256 frontRun = 60_000_000e6;
    deal(address(USDC), attacker, frontRun);
    vm.startPrank(attacker);
    USDC.forceApprove(address(THREE_POOL), frontRun);
    THREE_POOL.exchange(1, 0, frontRun, 0);
    vm.stopPrank();
    assertLt(DAI.balanceOf(attacker), (frontRun * 1e12 * 9900) / 10_000);
  }

  function _listUsdc() internal returns (OxidePortal usdcPortal) {
    usdcPortal = _buildPortal(address(USDC));
    IForwardingTable.IntentFees[] memory intents = new IForwardingTable.IntentFees[](1);
    intents[0] = IForwardingTable.IntentFees({intent: Intents.DEPOSIT, beneficiaryFee: 0, sweepTip: USDC_SWEEP_TIP});
    vm.prank(OWNER);
    forwardingTable.addRow(address(USDC), IOxidePortal(address(usdcPortal)), intents);
  }

  function _depositIntent() internal pure returns (bytes memory) {
    return abi.encode(RECIPIENT);
  }

  function _sipa() internal returns (DepositSIPA) {
    return DepositSIPA(
      sipaFactory.deploySIPA(
        address(depositSIPAImplementation),
        keccak256(_depositIntent()),
        _recoveryCommitment(string.concat("recovery", vm.toString(sipaNonce++))),
        ROLLUP_VERSION,
        true,
        forwardingTable
      )
    );
  }

  function _sweep(DepositSIPA _sipaContract, IERC20 _token, uint256 _amount) internal {
    deal(address(_token), address(_sipaContract), _amount);
    _sipaContract.sweep(address(_token), relayer, _depositIntent(), "");
  }
}
