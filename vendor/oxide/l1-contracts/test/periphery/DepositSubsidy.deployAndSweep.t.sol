// SPDX-License-Identifier: Apache-2.0
pragma solidity >=0.8.27;

import {IERC20} from "@oz/token/ERC20/IERC20.sol";
import {ReentrancyGuardTransient} from "@oz/utils/ReentrancyGuardTransient.sol";

import {DepositSIPA, DEPOSIT_FEE} from "@periphery/DepositSIPA.sol";
import {DepositSubsidy} from "@periphery/DepositSubsidy.sol";
import {Errors} from "@periphery/Errors.sol";
import {SIPAFactory} from "@periphery/SIPAFactory.sol";
import {SIPABase} from "@periphery/SIPABase.sol";
import {AggregatorV3Interface} from "@periphery/interfaces/AggregatorV3Interface.sol";
import {ISIPA} from "@periphery/interfaces/ISIPA.sol";

import {GasBurningSIPA} from "@test/periphery/GasBurningSIPA.sol";
import {SweepGasFixture} from "@test/periphery/SweepGasFixture.sol";
import {MockPortal} from "@test/mocks/MockPortal.sol";
import {MockV3Aggregator} from "@test/mocks/MockV3Aggregator.sol";

contract BurningSIPAFactory {
  address internal immutable PORTAL;
  uint256 internal immutable FEE;
  uint256 internal immutable BURN;

  constructor(address _portal, uint256 _fee, uint256 _burn) {
    PORTAL = _portal;
    FEE = _fee;
    BURN = _burn;
  }

  function implementationFor(address, SIPABase.Intent) external view returns (address) {
    return address(this);
  }

  function sipaIntentOf(address) external pure returns (SIPABase.Intent) {
    return SIPABase.Intent.Deposit;
  }

  function predictSIPA(address, bytes32, bytes32, uint256, bool) public view returns (address) {
    bytes32 initCodeHash = keccak256(abi.encodePacked(type(GasBurningSIPA).creationCode, abi.encode(PORTAL, FEE, BURN)));
    return address(uint160(uint256(keccak256(abi.encodePacked(bytes1(0xff), address(this), bytes32(0), initCodeHash)))));
  }

  function deploySIPA(address, bytes32, bytes32, uint256, bool) public virtual returns (address) {
    return address(new GasBurningSIPA{salt: bytes32(0)}(PORTAL, FEE, BURN));
  }
}

contract ReenteringSIPAFactory is BurningSIPAFactory {
  address internal immutable TOKEN;

  constructor(address _portal, uint256 _fee, address _token) BurningSIPAFactory(_portal, _fee, 0) {
    TOKEN = _token;
  }

  function deploySIPA(address, bytes32, bytes32, uint256, bool) public override returns (address) {
    DepositSubsidy(msg.sender).sweepForSubsidy(ISIPA(address(this)), TOKEN, address(this), "", "");
    return address(0);
  }
}

contract DeployAndSweepReentrantSIPA {
  DepositSubsidy internal immutable DEPOSIT_SUBSIDY;
  address internal immutable PORTAL;

  constructor(DepositSubsidy _depositSubsidy, address _portal) {
    DEPOSIT_SUBSIDY = _depositSubsidy;
    PORTAL = _portal;
  }

  function portal() external view returns (address) {
    return PORTAL;
  }

  function depositFee() external pure returns (uint256) {
    return DEPOSIT_FEE;
  }

  function sweep(address token, address relayer, bytes calldata intentData, bytes calldata proofs) external {
    DEPOSIT_SUBSIDY.deployAndSweepForSubsidy(
      SIPABase.Intent.Deposit, bytes32(0), true, token, relayer, intentData, proofs
    );
  }
}

contract DepositSubsidyDeployAndSweepTest is SweepGasFixture {
  uint256 internal constant DEPOSIT = 100 ether;
  uint256 internal constant CEILING_BOUND_BURN = 1_000_000;

  DepositSubsidy internal sm;
  MockV3Aggregator internal feed;

  function setUp() public virtual override {
    super.setUp();
    feed = new MockV3Aggregator(8, PRICED_FEED_ANSWER);
    sm = _newSubsidy(address(portal), sipaFactory);
    vm.fee(PRICED_BASEFEE);
    vm.txGasPrice(PRICED_BASEFEE);
  }

  function test_GivenNoSIPAAtTheAddress_WhenDeployAndSweep_ThenItDeploysSweepsAndPays() external {
    bytes memory intent = _depositIntent("absent");
    address sipa = _predictDepositSIPA(intent);
    underlying.mint(sipa, DEPOSIT);
    uint256 portalBefore = underlying.balanceOf(address(portal));
    uint256 relayerBefore = underlying.balanceOf(relayer);
    assertEq(sipa.code.length, 0, "the SIPA must not exist before the call");

    uint256 subsidy = _deployAndSweep(intent);

    assertEq(
      uint8(sipaFactory.sipaIntentOf(sipa)), uint8(SIPABase.Intent.Deposit), "the call deployed a blessed deposit SIPA"
    );
    assertGt(subsidy, 0, "the deploy and sweep was paid a subsidy");
    assertEq(underlying.balanceOf(address(portal)) - portalBefore, DEPOSIT - DEPOSIT_FEE, "the deposit bridged");
    assertEq(underlying.balanceOf(relayer) - relayerBefore, DEPOSIT_FEE + subsidy, "the relayer got fee and subsidy");
    assertEq(underlying.balanceOf(sipa), 0, "the SIPA was swept");
  }

  function test_GivenAFrontRunDeploy_WhenDeployAndSweep_ThenTheSweepStillLands() external {
    bytes memory intent = _depositIntent("frontRun");
    address sipa = sipaFactory.deploySIPA(
      address(depositSIPAImplementation), keccak256(intent), _recoveryCommitment("recovery"), ROLLUP_VERSION, true
    );
    underlying.mint(sipa, DEPOSIT);
    uint256 portalBefore = underlying.balanceOf(address(portal));
    uint256 relayerBefore = underlying.balanceOf(relayer);

    uint256 subsidy = _deployAndSweep(intent);

    assertGt(subsidy, 0, "the sweep of a front-run SIPA was paid a subsidy");
    assertEq(underlying.balanceOf(address(portal)) - portalBefore, DEPOSIT - DEPOSIT_FEE, "the deposit bridged");
    assertEq(underlying.balanceOf(relayer) - relayerBefore, DEPOSIT_FEE + subsidy, "the relayer got fee and subsidy");
    assertEq(underlying.balanceOf(sipa), 0, "the SIPA was swept");
  }

  function test_GivenACeilingBoundDeploy_WhenDeployAndSweep_ThenItIsPricedAtTheCeilingPlusTheDeployAllowance()
    external
  {
    (DepositSubsidy burner, BurningSIPAFactory factory) = _burningSubsidy();
    address sipa = factory.predictSIPA(address(0), bytes32(0), bytes32(0), 0, true);
    assertEq(sipa.code.length, 0, "the SIPA must not exist before the call");

    uint256 subsidy = _deployAndSweepOn(burner, address(underlying));

    assertGt(sipa.code.length, 0, "the call deployed the SIPA");
    assertEq(
      _pricedGas(subsidy, DEPOSIT_FEE),
      burner.SWEEP_GAS_DEPOSIT_CEILING() + burner.SWEEP_GAS_DEPLOY_ALLOWANCE(),
      "a deploy must raise the ceiling by the deploy allowance"
    );
  }

  function test_GivenACeilingBoundSIPAAlreadyDeployed_WhenDeployAndSweep_ThenItGetsNoDeployAllowance() external {
    (DepositSubsidy burner, BurningSIPAFactory factory) = _burningSubsidy();
    factory.deploySIPA(address(0), bytes32(0), bytes32(0), 0, true);

    uint256 subsidy = _deployAndSweepOn(burner, address(underlying));

    assertEq(
      _pricedGas(subsidy, DEPOSIT_FEE),
      burner.SWEEP_GAS_DEPOSIT_CEILING(),
      "a sweep that deployed nothing must not draw the deploy allowance"
    );
  }

  function test_GivenAnUnknownToken_WhenDeployAndSweepDeploys_ThenNothingIsPriced() external {
    (DepositSubsidy burner, BurningSIPAFactory factory) = _burningSubsidy();
    address sipa = factory.predictSIPA(address(0), bytes32(0), bytes32(0), 0, true);

    uint256 subsidy = _deployAndSweepOn(burner, makeAddr("unknownToken"));

    assertGt(sipa.code.length, 0, "the call deployed the SIPA");
    assertEq(subsidy, 0, "the deploy allowance must not lift a zero ceiling");
  }

  function test_GivenAnIntentWithoutAnImplementation_WhenDeployAndSweep_ThenReverts() external {
    vm.expectRevert(abi.encodeWithSelector(Errors.DepositSubsidy__NoImplementationForIntent.selector, uint8(0)));
    sm.deployAndSweepForSubsidy(
      SIPABase.Intent.None,
      _recoveryCommitment("recovery"),
      true,
      address(underlying),
      relayer,
      _depositIntent("none"),
      ""
    );

    MockPortal barePortal = new MockPortal(IERC20(address(underlying)), ROLLUP_VERSION);
    DepositSubsidy bare = _newSubsidy(address(barePortal), sipaFactory);
    vm.expectRevert(abi.encodeWithSelector(Errors.DepositSubsidy__NoImplementationForIntent.selector, uint8(1)));
    bare.deployAndSweepForSubsidy(
      SIPABase.Intent.Deposit,
      _recoveryCommitment("recovery"),
      true,
      address(underlying),
      relayer,
      _depositIntent("bare"),
      ""
    );
  }

  function test_GivenADeployThatReentersSweepForSubsidy_ThenItIsRefused() external {
    ReenteringSIPAFactory factory = new ReenteringSIPAFactory(address(portal), DEPOSIT_FEE, address(underlying));
    DepositSubsidy reentered = _newSubsidy(address(portal), SIPAFactory(address(factory)));

    vm.expectRevert(ReentrancyGuardTransient.ReentrancyGuardReentrantCall.selector);
    _deployAndSweepOn(reentered, address(underlying));
  }

  function test_GivenASweepThatReentersDeployAndSweep_ThenItIsRefused() external {
    DeployAndSweepReentrantSIPA attacker = new DeployAndSweepReentrantSIPA(sm, address(portal));
    vm.mockCall(
      address(sipaFactory),
      abi.encodeCall(SIPAFactory.sipaIntentOf, (address(attacker))),
      abi.encode(SIPABase.Intent.Deposit)
    );

    vm.expectRevert(ReentrancyGuardTransient.ReentrancyGuardReentrantCall.selector);
    sm.sweepForSubsidy(ISIPA(address(attacker)), address(underlying), relayer, "", "");
  }

  function _newSubsidy(address _portal, SIPAFactory _factory) internal returns (DepositSubsidy subsidy) {
    subsidy = new DepositSubsidy(OWNER, _portal, AggregatorV3Interface(address(feed)), _factory);
    underlying.mint(address(subsidy), 1_000_000 ether);
    vm.prank(OWNER);
    subsidy.setDepositConfig(PRICED_MIN_PROFIT, type(uint128).max, PRICED_MIN_PROFIT, 0, 0);
  }

  function _burningSubsidy() internal returns (DepositSubsidy subsidy, BurningSIPAFactory factory) {
    factory = new BurningSIPAFactory(address(portal), DEPOSIT_FEE, CEILING_BOUND_BURN);
    subsidy = _newSubsidy(address(portal), SIPAFactory(address(factory)));
  }

  function _depositIntent(bytes32 _salt) internal pure returns (bytes memory) {
    return abi.encode(_field(_salt));
  }

  function _predictDepositSIPA(bytes memory _intent) internal view returns (address) {
    return sipaFactory.predictSIPA(
      address(depositSIPAImplementation), keccak256(_intent), _recoveryCommitment("recovery"), ROLLUP_VERSION, true
    );
  }

  function _deployAndSweep(bytes memory _intent) internal returns (uint256) {
    vm.prank(relayer);
    return sm.deployAndSweepForSubsidy(
      SIPABase.Intent.Deposit, _recoveryCommitment("recovery"), true, address(underlying), relayer, _intent, ""
    );
  }

  function _deployAndSweepOn(DepositSubsidy _subsidy, address _token) internal returns (uint256) {
    return _subsidy.deployAndSweepForSubsidy(SIPABase.Intent.Deposit, bytes32(0), true, _token, relayer, "", "");
  }
}
