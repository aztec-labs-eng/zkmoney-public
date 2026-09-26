// SPDX-License-Identifier: Apache-2.0
pragma solidity >=0.8.27;
import {console2} from "forge-std/console2.sol";

import {DepositSIPA, DEPOSIT_FEE} from "@periphery/DepositSIPA.sol";
import {RegistrationSIPA} from "@periphery/RegistrationSIPA.sol";
import {IOxidePortal} from "@core/interfaces/IOxidePortal.sol";
import {METADATA_UPDATE_SWEEP_FEE} from "@periphery/UpdateMetadataSIPA.sol";
import {USDC, USDT} from "@periphery/ThreePoolLib.sol";
import {DepositSubsidy} from "@periphery/DepositSubsidy.sol";
import {SIPAFactory} from "@periphery/SIPAFactory.sol";
import {SIPABase} from "@periphery/SIPABase.sol";
import {AggregatorV3Interface} from "@periphery/interfaces/AggregatorV3Interface.sol";
import {DomainAuth, INameRegistry} from "@periphery/interfaces/INameRegistry.sol";
import {IERC20} from "@oz/token/ERC20/IERC20.sol";
import {ISIPA} from "@periphery/interfaces/ISIPA.sol";

import {Errors} from "@periphery/Errors.sol";
import {ReentrancyGuardTransient} from "@oz/utils/ReentrancyGuardTransient.sol";

import {GasBurningSIPA} from "@test/periphery/GasBurningSIPA.sol";
import {SweepGasFixture} from "@test/periphery/SweepGasFixture.sol";
import {MockV3Aggregator} from "@test/mocks/MockV3Aggregator.sol";
import {MockPortal} from "@test/mocks/MockPortal.sol";

contract ReentrantSIPA {
  DepositSubsidy internal immutable DEPOSIT_SUBSIDY;
  address internal immutable PORTAL;
  uint256 internal immutable FEE;

  constructor(DepositSubsidy _depositSubsidy, address _portal, uint256 _fee) {
    DEPOSIT_SUBSIDY = _depositSubsidy;
    PORTAL = _portal;
    FEE = _fee;
  }

  function portal() external view returns (address) {
    return PORTAL;
  }

  function depositFee() external view returns (uint256) {
    return FEE;
  }

  function sweep(address token, address relayer, bytes calldata intentData, bytes calldata proofs) external {
    DEPOSIT_SUBSIDY.sweepForSubsidy(ISIPA(address(this)), token, relayer, intentData, proofs);
  }
}

contract DepositSubsidyIntentPricingTest is SweepGasFixture {
  uint256 internal constant DEPOSIT = 100 ether;

  DepositSubsidy internal sm;
  MockV3Aggregator internal feed;
  GasBurningSIPA internal metadataGasBurner;

  function setUp() public virtual override {
    super.setUp();
    feed = new MockV3Aggregator(8, PRICED_FEED_ANSWER);
    sm = new DepositSubsidy(OWNER, address(portal), AggregatorV3Interface(address(feed)), sipaFactory);
    underlying.mint(address(sm), 1_000_000 ether);

    vm.prank(OWNER);
    sm.setDepositConfig(PRICED_MIN_PROFIT, type(uint128).max, PRICED_MIN_PROFIT);
    vm.fee(PRICED_BASEFEE);
    vm.txGasPrice(PRICED_BASEFEE);
    metadataGasBurner = new GasBurningSIPA(address(portal), METADATA_UPDATE_SWEEP_FEE, 1_000_000);
    vm.mockCall(
      address(sipaFactory),
      abi.encodeCall(SIPAFactory.sipaIntentOf, (address(metadataGasBurner))),
      abi.encode(SIPABase.Intent.UpdateMetadata)
    );
  }

  function _depositIntent(bytes32 _salt) internal pure returns (bytes memory) {
    return abi.encode(_field(_salt));
  }

  function _depositSIPA(bytes memory _intent) internal returns (DepositSIPA) {
    return DepositSIPA(
      sipaFactory.deploySIPA(
        address(depositSIPAImplementation), keccak256(_intent), _recoveryCommitment("recovery"), ROLLUP_VERSION, true
      )
    );
  }

  function _sweep(address _sipa, bytes memory _intentData, bytes memory _proofs) internal returns (uint256) {
    return sm.sweepForSubsidy(ISIPA(_sipa), address(underlying), relayer, _intentData, _proofs);
  }

  function test_GivenANonSIPATarget_ThenTheSweepIsRefused() external {
    vm.expectRevert(abi.encodeWithSelector(Errors.DepositSubsidy__NotASIPA.selector, address(this)));
    sm.sweepForSubsidy(ISIPA(address(this)), address(underlying), relayer, _depositIntent("plain"), "");
  }

  function test_GivenASIPABoundToAnotherPortal_ThenTheSweepIsRefused() external {
    MockPortal foreignPortal = new MockPortal(IERC20(address(underlying)), ROLLUP_VERSION);
    DepositSIPA foreignImplementation = new DepositSIPA(IOxidePortal(address(foreignPortal)), DEPOSIT_FEE);
    RegistrationSIPA foreignRegistration =
      new RegistrationSIPA(IOxidePortal(address(foreignPortal)), INameRegistry(address(nameRegistry)), DEPOSIT_FEE);
    vm.startPrank(OWNER);
    sipaFactory.bless(address(foreignImplementation));
    sipaFactory.bless(address(foreignRegistration));
    vm.stopPrank();

    DepositSIPA sipa = DepositSIPA(
      sipaFactory.deploySIPA(
        address(foreignImplementation),
        keccak256(_depositIntent("foreign")),
        _recoveryCommitment("recovery"),
        ROLLUP_VERSION,
        true
      )
    );
    underlying.mint(address(sipa), DEPOSIT);

    vm.expectRevert(abi.encodeWithSelector(Errors.DepositSubsidy__SIPABoundToAnotherPortal.selector, address(sipa)));
    sm.sweepForSubsidy(ISIPA(address(sipa)), address(underlying), relayer, _depositIntent("foreign"), "");
  }

  function test_GivenANestedSweep_ThenItIsRefusedRatherThanPaidTwice() external {
    ReentrantSIPA attacker = new ReentrantSIPA(sm, address(portal), DEPOSIT_FEE);
    vm.mockCall(
      address(sipaFactory),
      abi.encodeWithSelector(SIPAFactory.sipaIntentOf.selector),
      abi.encode(SIPABase.Intent.Deposit)
    );

    vm.expectRevert(ReentrancyGuardTransient.ReentrancyGuardReentrantCall.selector);
    sm.sweepForSubsidy(ISIPA(address(attacker)), address(underlying), relayer, _depositIntent("plain"), "");
  }

  function test_GivenAnUnfundedDepositSubsidy_ThenTheSweepStillLands() external {
    vm.prank(OWNER);
    sm.defund();
    assertEq(underlying.balanceOf(address(sm)), 0, "the deposit subsidy must start empty");

    DepositSIPA sipa = _depositSIPA(_depositIntent("unfunded"));
    underlying.mint(address(sipa), DEPOSIT);
    uint256 portalBefore = underlying.balanceOf(address(portal));
    uint256 relayerBefore = underlying.balanceOf(relayer);
    uint256 fee = DEPOSIT_FEE;

    uint256 subsidy = _sweep(address(sipa), _depositIntent("unfunded"), "");

    assertEq(subsidy, 0, "an empty reserve quotes nothing");
    assertEq(underlying.balanceOf(address(portal)) - portalBefore, DEPOSIT - fee, "the deposit still bridged");
    assertEq(underlying.balanceOf(relayer) - relayerBefore, fee, "the relayer got the fee and nothing more");
    assertEq(underlying.balanceOf(address(sipa)), 0, "the SIPA was swept");
  }

  function test_GivenAnAnswerThatWouldOverflowTheQuote_ThenTheSweepStillLands() external {
    uint128 cap = 1 ether;
    uint128 fee = uint128(DEPOSIT_FEE);
    vm.prank(OWNER);
    sm.setDepositConfig(fee, cap, fee);
    feed.setAnswer(1e60);

    DepositSIPA sipa = _depositSIPA(_depositIntent("absurd"));
    underlying.mint(address(sipa), DEPOSIT);
    uint256 portalBefore = underlying.balanceOf(address(portal));
    uint256 relayerBefore = underlying.balanceOf(relayer);

    uint256 subsidy = _sweep(address(sipa), _depositIntent("absurd"), "");

    assertEq(subsidy, cap, "a bad-but-valid answer is bounded by the max, not by an overflow");
    assertEq(underlying.balanceOf(address(portal)) - portalBefore, DEPOSIT - fee, "the deposit still bridged");
    assertEq(underlying.balanceOf(relayer) - relayerBefore, fee + cap, "the relayer got the fee and the capped payout");
    assertEq(underlying.balanceOf(address(sipa)), 0, "the SIPA was swept");
  }

  function test_GivenFeedDecimalsPastThePowerOfTen_ThenTheSweepQuotesZeroAndLands() external {
    MockV3Aggregator wideFeed = new MockV3Aggregator(78, 1e8);
    sm = new DepositSubsidy(OWNER, address(portal), AggregatorV3Interface(address(wideFeed)), sipaFactory);
    underlying.mint(address(sm), 1_000_000 ether);
    uint128 fee = uint128(DEPOSIT_FEE);
    vm.prank(OWNER);
    sm.setDepositConfig(fee, type(uint128).max, fee);

    DepositSIPA sipa = _depositSIPA(_depositIntent("wide"));
    underlying.mint(address(sipa), DEPOSIT);
    uint256 portalBefore = underlying.balanceOf(address(portal));

    uint256 subsidy = _sweep(address(sipa), _depositIntent("wide"), "");

    assertEq(subsidy, 0, "a bad reading quotes nothing");
    assertEq(underlying.balanceOf(address(portal)) - portalBefore, DEPOSIT - fee, "the deposit still bridged");
    assertEq(underlying.balanceOf(address(sipa)), 0, "the SIPA was swept");
  }

  function test_GivenADepositSweep_ThenItIsQuotedOnWhatItBurnt() external {
    DepositSIPA sipa = _depositSIPA(_depositIntent("plain"));
    underlying.mint(address(sipa), DEPOSIT);

    uint256 priced = _pricedGas(_sweep(address(sipa), _depositIntent("plain"), ""), DEPOSIT_FEE);
    console2.log("deposit priced gas", priced);

    assertLt(
      priced,
      sm.SWEEP_GAS_DEPOSIT_CEILING(),
      "an ordinary deposit sweep must price on its meter, not on the deposit ceiling"
    );
  }

  function test_GivenARegistrationSweep_ThenItIsBoundedByTheRegistrationCeiling() external {
    bytes memory registrationData = _registrationData(NAME_HASH, defaultOwner);
    SIPABase sipa = _deployAndFund(registrationData, DEPOSIT);
    bytes memory consent = _consentSig(bootstrapKey, registrationData);
    DomainAuth memory auth = _domainAuth(NAME_HASH, defaultOwner, nextNonce++, block.timestamp + 1 days);

    uint256 priced = _pricedGas(
      _sweep(address(sipa), registrationData, _regProofs(consent, auth, _noTerms())),
      registrationSIPAImplementation.DEPOSIT_FEE()
    );
    console2.log("registration priced gas", priced);

    assertGt(
      priced, sm.SWEEP_GAS_DEPOSIT_CEILING(), "a registration must price above everything the deposit ceiling can pay"
    );
    assertLe(
      priced, sm.SWEEP_GAS_REGISTRATION_CEILING(), "a registration priced past its own ceiling: the cap is not binding"
    );
  }

  function test_GivenBothIntents_ThenTheRegistrationIsQuotedWellAboveTheDeposit() external {
    DepositSIPA plain = _depositSIPA(_depositIntent("plain"));
    underlying.mint(address(plain), DEPOSIT);
    uint256 depositQuote = _pricedGas(_sweep(address(plain), _depositIntent("plain"), ""), DEPOSIT_FEE);

    bytes memory registrationData = _registrationData(NAME_HASH, defaultOwner);
    SIPABase sipa = _deployAndFund(registrationData, DEPOSIT);
    bytes memory consent = _consentSig(bootstrapKey, registrationData);
    DomainAuth memory auth = _domainAuth(NAME_HASH, defaultOwner, nextNonce++, block.timestamp + 1 days);
    uint256 registrationQuote = _pricedGas(
      _sweep(address(sipa), registrationData, _regProofs(consent, auth, _noTerms())),
      registrationSIPAImplementation.DEPOSIT_FEE()
    );

    console2.log("deposit quote", depositQuote, "registration quote", registrationQuote);
    assertGt(registrationQuote, depositQuote * 2, "the registration's extra work must be priced");
  }

  function test_GivenMoreGasOnHand_ThenTheQuoteDoesNotMove() external {
    vm.mockCall(
      address(sipaFactory),
      abi.encodeWithSelector(SIPAFactory.sipaIntentOf.selector),
      abi.encode(SIPABase.Intent.Deposit)
    );
    GasBurningSIPA fixedWork = new GasBurningSIPA(address(portal), DEPOSIT_FEE, 100_000);

    _burnSweep(fixedWork, 3_000_000);
    uint256 tight = _burnSweep(fixedWork, 300_000);
    uint256 roomy = _burnSweep(fixedWork, 3_000_000);

    assertGt(tight, 0, "the sweep must have quoted something to compare");
    assertEq(roomy, tight, "the quote follows the gas the sweep consumed, not the gas the call was given");
    assertLt(
      _pricedGas(tight, DEPOSIT_FEE),
      sm.SWEEP_GAS_DEPOSIT_CEILING(),
      "the stand-in must stay under the ceiling, or the cap is what is holding the two quotes level"
    );
  }

  function test_metadataSweepCapsUnderlyingSubsidy() external {
    _assertMetadataSubsidyCap(address(underlying), 0);
  }

  function test_metadataSweepCapsUsdcSubsidy() external {
    _assertMetadataSubsidyCap(address(USDC), sm.SWEEP_GAS_SWAP_USDC_HOP());
  }

  function test_metadataSweepCapsUsdtSubsidy() external {
    _assertMetadataSubsidyCap(address(USDT), sm.SWEEP_GAS_SWAP_USDT_HOP());
  }

  function _assertMetadataSubsidyCap(address token, uint256 swapAllowance) internal {
    uint256 ceiling = sm.SWEEP_GAS_METADATA_UPDATE_CEILING() + swapAllowance;
    uint256 expectedSubsidy =
      (ceiling * PRICED_UNIT_FEE * uint256(PRICED_FEED_ANSWER)) / 1e8 + PRICED_MIN_PROFIT - METADATA_UPDATE_SWEEP_FEE;
    uint256 relayerBefore = underlying.balanceOf(relayer);

    uint256 subsidy = sm.sweepForSubsidy(ISIPA(address(metadataGasBurner)), token, relayer, "", "");

    assertEq(subsidy, expectedSubsidy, "metadata subsidy must reach its cap with the token swap allowance");
    assertEq(_pricedGas(subsidy, METADATA_UPDATE_SWEEP_FEE), ceiling);
    assertEq(underlying.balanceOf(relayer) - relayerBefore, expectedSubsidy);
  }

  function _burnSweep(GasBurningSIPA _sipa, uint256 _gas) internal returns (uint256) {
    return sm.sweepForSubsidy{gas: _gas}(ISIPA(address(_sipa)), address(underlying), relayer, "", "");
  }
}
