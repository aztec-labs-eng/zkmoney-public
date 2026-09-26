// SPDX-License-Identifier: Apache-2.0
pragma solidity >=0.8.27;

import {DepositSIPA, DEPOSIT_FEE} from "@periphery/DepositSIPA.sol";
import {RegistrationSIPA, REGISTRATION_SWEEP_FEE} from "@periphery/RegistrationSIPA.sol";
import {SIPABase} from "@periphery/SIPABase.sol";
import {DAI, USDC, USDT, THREE_POOL} from "@periphery/ThreePoolLib.sol";
import {DepositSubsidy} from "@periphery/DepositSubsidy.sol";
import {RegistrationController} from "@periphery/RegistrationController.sol";
import {INameRegistry, DomainAuth} from "@periphery/interfaces/INameRegistry.sol";
import {SignedTerms} from "@periphery/interfaces/IRegistrationController.sol";
import {IOxidePortal} from "@core/interfaces/IOxidePortal.sol";
import {OxidePortal} from "@core/OxidePortal.sol";
import {IERC20} from "@oz/token/ERC20/IERC20.sol";
import {IERC20 as IERC20OZ} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@oz/token/ERC20/utils/SafeERC20.sol";
import {TestERC20} from "@aztec/mock/TestERC20.sol";
import {console2} from "forge-std/console2.sol";

import {MainnetForkFixture} from "@test/fork/MainnetForkFixture.sol";
import {OxidePortalBase} from "@test/core/OxidePortalBase.t.sol";
import {RegistrationTestBase} from "@test/periphery/registration/RegistrationTestBase.sol";
import {MockV3Aggregator} from "@test/mocks/MockV3Aggregator.sol";
import {ISIPA} from "@periphery/interfaces/ISIPA.sol";
import {IOxideAccountFactory} from "@periphery/interfaces/IOxideAccountFactory.sol";
import {Errors} from "@periphery/Errors.sol";

contract SIPAStableSweepForkTest is MainnetForkFixture, RegistrationTestBase {
  using SafeERC20 for IERC20;

  uint256 internal constant AMOUNT_6DEC = 2500e6;
  uint256 internal constant AMOUNT_18DEC = 2500e18;

  uint256 internal constant REGISTRATION_QUOTE_6DEC = 15e6;
  uint256 internal constant REGISTRATION_QUOTE_18DEC = 15e18;

  address internal donationHolder = makeAddr("donationHolder");
  uint256 internal sipaNonce;
  bytes32 internal constant RECIPIENT = keccak256("swap-recipient");

  OxidePortal internal daiPortal;
  uint256 internal fee;

  function setUp() public override(OxidePortalBase, RegistrationTestBase) {
    _selectMainnetFork();
    RegistrationTestBase.setUp();

    daiPortal = _buildPortal(address(DAI));
    depositSIPAImplementation = new DepositSIPA(IOxidePortal(address(daiPortal)), DEPOSIT_FEE);
    registrationSIPAImplementation = new RegistrationSIPA(
      IOxidePortal(address(daiPortal)), INameRegistry(address(nameRegistry)), REGISTRATION_SWEEP_FEE
    );
    vm.startPrank(OWNER);
    sipaFactory.bless(address(depositSIPAImplementation));
    sipaFactory.bless(address(registrationSIPAImplementation));
    daiPortal.initialize(L2_PORTAL);
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

    fee = DEPOSIT_FEE;
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

  function test_GivenUsdc_WhenDeposited_ThenTheSwapRoutePricesItself() external {
    DepositSubsidy sm = _depositSubsidy(fee);

    uint256 direct = _sweepForSubsidy(_sipa(), DAI, AMOUNT_18DEC, address(sm));
    uint256 viaUsdc = _sweepForSubsidy(_sipa(), USDC, AMOUNT_6DEC, address(sm));

    assertGt(direct, 0, "a direct sweep must draw a subsidy to compare against");
    assertGt(viaUsdc, direct, "the swap route must draw more than the direct route");
    assertEq(DAI.balanceOf(relayer), 2 * fee + direct + viaUsdc);
    assertEq(USDC.balanceOf(relayer), 0);
  }

  function test_GivenTheStableRoutes_ThenTheDepositHopCarriesTheThreePoolSwap() external {
    DepositSubsidy sm = _depositSubsidy(fee);

    uint256 dai = _steadyStateDepositGas(sm, DAI, AMOUNT_18DEC);
    uint256 usdc = _steadyStateDepositGas(sm, USDC, AMOUNT_6DEC);
    uint256 usdt = _steadyStateDepositGas(sm, USDT, AMOUNT_6DEC);
    console2.log("deposit priced gas: dai", dai, "usdc hop", usdc - dai);
    console2.log("deposit priced gas: usdt hop", usdt - dai);

    assertLe(usdc - dai, sm.SWEEP_GAS_SWAP_USDC_HOP(), "the USDC hop no longer covers the 3pool swap on a deposit");
    assertLe(usdt - dai, sm.SWEEP_GAS_SWAP_USDT_HOP(), "the USDT hop no longer covers the 3pool swap on a deposit");
  }

  function test_GivenTheStableRoutes_ThenTheRegistrationHopCarriesTheThreePoolSwap() external {
    DepositSubsidy sm = _depositSubsidy(REGISTRATION_SWEEP_FEE);

    uint256 dai = _steadyStateRegistrationGas(sm, DAI, REGISTRATION_QUOTE_18DEC, "reg.dai");
    uint256 usdc = _steadyStateRegistrationGas(sm, USDC, REGISTRATION_QUOTE_6DEC, "reg.usdc");
    uint256 usdt = _steadyStateRegistrationGas(sm, USDT, REGISTRATION_QUOTE_6DEC, "reg.usdt");
    console2.log("registration priced gas: dai", dai, "usdc hop", usdc - dai);
    console2.log("registration priced gas: usdt hop", usdt - dai);

    assertLe(usdc - dai, sm.SWEEP_GAS_SWAP_USDC_HOP(), "the USDC hop no longer covers the 3pool swap on a registration");
    assertLe(usdt - dai, sm.SWEEP_GAS_SWAP_USDT_HOP(), "the USDT hop no longer covers the 3pool swap on a registration");
  }

  function test_GivenSwapOutputBelowMinOut_WhenDeposited_ThenReverts() external {
    address attacker = makeAddr("attacker");
    uint256 frontRun = 60_000_000e6;
    deal(address(USDC), attacker, frontRun);
    vm.startPrank(attacker);
    USDC.forceApprove(address(THREE_POOL), frontRun);
    THREE_POOL.exchange(1, 0, frontRun, 0);
    vm.stopPrank();
    assertLt(DAI.balanceOf(attacker), (frontRun * 1e12 * 9900) / 10_000);

    DepositSIPA sipa = _sipa();
    deal(address(USDC), address(sipa), AMOUNT_6DEC);
    vm.expectRevert("Exchange resulted in fewer coins than expected");
    sipa.sweep(address(USDC), relayer, _depositIntent(), "");
  }

  function test_GivenSwapOutputBelowFee_WhenDeposited_ThenReverts() external {
    DepositSIPA sipa = _sipa();
    deal(address(USDC), address(sipa), 2e5);

    vm.expectPartialRevert(Errors.SIPA__SweepBelowDepositFee.selector);
    sipa.sweep(address(USDC), relayer, _depositIntent(), "");
  }

  function test_GivenTokenOutsideRoute_WhenDeposited_ThenReverts() external {
    DepositSIPA sipa = _sipa();
    TestERC20 other = new TestERC20("Other", "OTH", address(this));
    other.mint(address(sipa), AMOUNT_6DEC);

    vm.expectRevert(abi.encodeWithSelector(Errors.SIPA__TokenNotPortalUnderlying.selector, address(other)));
    sipa.sweep(address(other), relayer, _depositIntent(), "");
  }

  function test_GivenNonMainnetChain_WhenUsdcDeposited_ThenReverts() external {
    DepositSIPA sipa = _sipa();
    deal(address(USDC), address(sipa), AMOUNT_6DEC);
    vm.chainId(31_337);

    vm.expectRevert(abi.encodeWithSelector(Errors.SIPA__TokenNotPortalUnderlying.selector, address(USDC)));
    sipa.sweep(address(USDC), relayer, _depositIntent(), "");
  }

  function test_GivenNonMainnetChainWithAPortalForUsdc_WhenDeposited_ThenDirectPathWins() external {
    OxidePortal usdcPortal = _buildPortal(address(USDC));
    vm.prank(OWNER);
    usdcPortal.initialize(L2_PORTAL);
    uint256 threePoolUsdcBefore = USDC.balanceOf(address(THREE_POOL));
    vm.chainId(31_337);

    DepositSIPA sixDecImplementation = new DepositSIPA(IOxidePortal(address(usdcPortal)), 25e4);
    _sweep(_sipaOf(address(sixDecImplementation)), USDC, AMOUNT_6DEC);

    assertEq(USDC.balanceOf(address(usdcPortal)), AMOUNT_6DEC - 25e4);
    assertEq(USDC.balanceOf(address(THREE_POOL)), threePoolUsdcBefore);
    assertEq(DAI.balanceOf(address(daiPortal)), 0);
  }

  function test_GivenAUsdcPortal_WhenTheSwapSettlesInDai_ThenReverts() external {
    OxidePortal usdcPortal = _buildPortal(address(USDC));
    vm.prank(OWNER);
    usdcPortal.initialize(L2_PORTAL);
    DepositSIPA freshImplementation = new DepositSIPA(IOxidePortal(address(usdcPortal)), DEPOSIT_FEE);
    DepositSIPA sipa = _sipaOf(address(freshImplementation));
    deal(address(USDC), address(sipa), AMOUNT_6DEC);

    vm.expectRevert(abi.encodeWithSelector(Errors.SIPA__TokenNotPortalUnderlying.selector, address(DAI)));
    sipa.sweep(address(USDC), relayer, _depositIntent(), "");
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
    assertEq(DAI.balanceOf(FEE_BENEFICIARY), REGISTRATION_FEE - REGISTRATION_SWEEP_FEE);
    assertEq(DAI.balanceOf(relayer), REGISTRATION_SWEEP_FEE);
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
    assertEq(DAI.balanceOf(FEE_BENEFICIARY), REGISTRATION_FEE - REGISTRATION_SWEEP_FEE, "the funder is paid in DAI");
    assertEq(DAI.balanceOf(relayer), REGISTRATION_SWEEP_FEE, "the relayer is paid in DAI");
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
      DepositSubsidy(_sm).sweepForSubsidy(ISIPA(sipa), address(_token), relayer, data, proofs);
    }
  }

  function _steadyStateRegistrationGas(DepositSubsidy _sm, IERC20 _token, uint256 _amount, string memory _salt)
    internal
    returns (uint256)
  {
    _register(_token, _amount, string.concat(_salt, ".warm"), address(_sm));
    uint256 relayerBefore = DAI.balanceOf(relayer);
    _register(_token, _amount, string.concat(_salt, ".steady"), address(_sm));
    return (DAI.balanceOf(relayer) - relayerBefore - REGISTRATION_SWEEP_FEE) / 1e12;
  }

  function _steadyStateDepositGas(DepositSubsidy _sm, IERC20 _token, uint256 _amount) internal returns (uint256) {
    _sweepForSubsidy(_sipa(), _token, _amount, address(_sm));
    return _sweepForSubsidy(_sipa(), _token, _amount, address(_sm)) / 1e12;
  }

  function _depositSubsidy(uint256 _fee) internal returns (DepositSubsidy sm) {
    vm.fee(4e8);
    vm.txGasPrice(4e8);
    MockV3Aggregator aggregator = new MockV3Aggregator(8, 2500e8);
    sm = new DepositSubsidy(OWNER, address(daiPortal), aggregator, sipaFactory);
    vm.prank(OWNER);
    sm.setDepositConfig(uint128(_fee), type(uint128).max, uint128(_fee));
    deal(address(DAI), address(sm), 100e18);
  }

  function _depositIntent() internal pure returns (bytes memory) {
    return abi.encode(RECIPIENT);
  }

  function _sipa() internal returns (DepositSIPA) {
    return _sipaOf(address(depositSIPAImplementation));
  }

  function _sipaOf(address _implementation) internal returns (DepositSIPA) {
    return DepositSIPA(
      sipaFactory.deploySIPA(
        _implementation,
        keccak256(_depositIntent()),
        _recoveryCommitment(string.concat("recovery", vm.toString(sipaNonce++))),
        ROLLUP_VERSION,
        true
      )
    );
  }

  function _sweep(DepositSIPA _sipaContract, IERC20 _token, uint256 _amount) internal {
    deal(address(_token), address(_sipaContract), _amount);
    _sipaContract.sweep(address(_token), relayer, _depositIntent(), "");
  }

  function _sweepForSubsidy(DepositSIPA _sipaContract, IERC20 _token, uint256 _amount, address _sm)
    internal
    returns (uint256)
  {
    deal(address(_token), address(_sipaContract), _amount);
    return
      DepositSubsidy(_sm).sweepForSubsidy(ISIPA(address(_sipaContract)), address(_token), relayer, _depositIntent(), "");
  }
}
