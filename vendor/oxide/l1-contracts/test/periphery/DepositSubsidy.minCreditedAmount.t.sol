// SPDX-License-Identifier: Apache-2.0
pragma solidity >=0.8.27;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@oz/token/ERC20/IERC20.sol";

import {IOxidePortal} from "@core/interfaces/IOxidePortal.sol";
import {DepositSIPA, DEPOSIT_FEE} from "@periphery/DepositSIPA.sol";
import {DepositSubsidy} from "@periphery/DepositSubsidy.sol";
import {SIPAFactory} from "@periphery/SIPAFactory.sol";
import {SIPABase} from "@periphery/SIPABase.sol";
import {DAI, USDC, THREE_POOL} from "@periphery/ThreePoolLib.sol";
import {AggregatorV3Interface} from "@periphery/interfaces/AggregatorV3Interface.sol";
import {ISIPA} from "@periphery/interfaces/ISIPA.sol";

import {StablecoinMocks} from "@test/helpers/StablecoinMocks.sol";
import {MintableToken} from "@test/mocks/MintableToken.sol";
import {MockCurve3Pool} from "@test/mocks/MockCurve3Pool.sol";
import {MockV3Aggregator} from "@test/mocks/MockV3Aggregator.sol";
import {SweepGasFixture} from "@test/periphery/SweepGasFixture.sol";

contract DepositSubsidyMinCreditedAmountTest is SweepGasFixture {
  uint256 internal constant DEPOSIT = 100 ether;

  DepositSubsidy internal sm;

  function setUp() public virtual override {
    super.setUp();
    MockV3Aggregator feed = new MockV3Aggregator(8, PRICED_FEED_ANSWER);
    sm = new DepositSubsidy(OWNER, address(portal), AggregatorV3Interface(address(feed)), sipaFactory);
    underlying.mint(address(sm), 1_000_000 ether);
    vm.fee(PRICED_BASEFEE);
    vm.txGasPrice(PRICED_BASEFEE);
    _setMinCreditedAmount(0);
  }

  function test_GivenACreditBelowTheMinimum_WhenSweepForSubsidy_ThenTheSweepLandsWithoutASubsidy() external {
    bytes memory cd = _sweepCd(_fundedSIPA("below"), _depositIntent("below"));
    uint256 credited = _creditedBy(cd);
    _setMinCreditedAmount(credited + 1);

    _assertLandsUnpaid(cd, credited);
  }

  function test_GivenACreditAtTheMinimum_WhenSweepForSubsidy_ThenItIsPaidAsWithoutAMinimum() external {
    bytes memory cd = _sweepCd(_fundedSIPA("at"), _depositIntent("at"));
    _assertPaidAsWithoutAMinimum(cd, 0);
  }

  function test_GivenACreditAboveTheMinimum_WhenSweepForSubsidy_ThenItIsPaidAsWithoutAMinimum() external {
    bytes memory cd = _sweepCd(_fundedSIPA("above"), _depositIntent("above"));
    _assertPaidAsWithoutAMinimum(cd, 1);
  }

  function test_GivenACreditBelowTheMinimum_WhenDeployAndSweep_ThenTheSweepLandsWithoutASubsidy() external {
    bytes memory cd = _deployCd(_fundedPrediction("deployBelow"));
    uint256 credited = _creditedBy(cd);
    _setMinCreditedAmount(credited + 1);

    _assertLandsUnpaid(cd, credited);
  }

  function test_GivenACreditAtTheMinimum_WhenDeployAndSweep_ThenItIsPaidAsWithoutAMinimum() external {
    _assertPaidAsWithoutAMinimum(_deployCd(_fundedPrediction("deployAt")), 0);
  }

  function test_GivenACreditAboveTheMinimum_WhenDeployAndSweep_ThenItIsPaidAsWithoutAMinimum() external {
    _assertPaidAsWithoutAMinimum(_deployCd(_fundedPrediction("deployAbove")), 1);
  }

  function test_GivenADeposit_ThenTheMeasuredCreditIsWhatThePortalCredits() external {
    bytes memory cd = _sweepCd(_fundedSIPA("credit"), _depositIntent("credit"));
    assertEq(_creditedBy(cd), DEPOSIT - DEPOSIT_FEE - portal.FPC_FUNDING_CUT(), "the portal delta is the credit");
  }

  function _assertPaidAsWithoutAMinimum(bytes memory _cd, uint256 _margin) internal {
    uint256 credited = _creditedBy(_cd);
    uint256 snapshot = vm.snapshotState();
    _setMinCreditedAmount(0);
    uint256 unbounded = _submit(_cd);
    vm.revertToState(snapshot);

    _setMinCreditedAmount(credited - _margin);
    uint256 subsidy = _submit(_cd);

    assertGt(subsidy, 0, "a credit that meets the minimum must be paid");
    assertEq(subsidy, unbounded, "a credit that meets the minimum must be paid as if there were no minimum");
  }

  function _assertLandsUnpaid(bytes memory _cd, uint256 _credited) internal {
    uint256 portalBefore = underlying.balanceOf(address(portal));
    uint256 relayerBefore = underlying.balanceOf(relayer);
    uint256 budgetBefore = underlying.balanceOf(address(sm));

    uint256 subsidy = _submit(_cd);

    assertEq(subsidy, 0, "a credit under the minimum must not be subsidized");
    assertEq(underlying.balanceOf(address(portal)) - portalBefore, _credited, "the deposit still bridged");
    assertEq(underlying.balanceOf(relayer) - relayerBefore, DEPOSIT_FEE, "the relayer keeps the fee");
    assertEq(underlying.balanceOf(address(sm)), budgetBefore, "the budget is untouched");
  }

  function _creditedBy(bytes memory _cd) internal returns (uint256 credited) {
    uint256 snapshot = vm.snapshotState();
    uint256 before = underlying.balanceOf(address(portal));
    _submit(_cd);
    credited = underlying.balanceOf(address(portal)) - before;
    vm.revertToState(snapshot);
  }

  function _setMinCreditedAmount(uint256 _minCreditedAmount) internal {
    vm.prank(OWNER);
    sm.setDepositConfig(PRICED_MIN_PROFIT, type(uint128).max, PRICED_MIN_PROFIT, uint128(_minCreditedAmount), 0);
  }

  function _submit(bytes memory _callData) internal returns (uint256 quote) {
    vm.prank(relayer);
    (bool ok, bytes memory ret) = address(sm).call(_callData);
    require(ok, "sweep reverted");
    quote = abi.decode(ret, (uint256));
  }

  function _depositIntent(bytes32 _salt) internal pure returns (bytes memory) {
    return abi.encode(_field(_salt));
  }

  function _fundedSIPA(bytes32 _salt) internal returns (address sipa) {
    sipa = sipaFactory.deploySIPA(
      address(depositSIPAImplementation),
      keccak256(_depositIntent(_salt)),
      _recoveryCommitment("recovery"),
      ROLLUP_VERSION,
      true
    );
    underlying.mint(sipa, DEPOSIT);
  }

  function _fundedPrediction(bytes32 _salt) internal returns (bytes memory intent) {
    intent = _depositIntent(_salt);
    address sipa = sipaFactory.predictSIPA(
      address(depositSIPAImplementation), keccak256(intent), _recoveryCommitment("recovery"), ROLLUP_VERSION, true
    );
    underlying.mint(sipa, DEPOSIT);
  }

  function _sweepCd(address _sipa, bytes memory _intentData) internal view returns (bytes memory) {
    return abi.encodeCall(DepositSubsidy.sweepForSubsidy, (ISIPA(_sipa), address(underlying), relayer, _intentData, ""));
  }

  function _deployCd(bytes memory _intentData) internal view returns (bytes memory) {
    return abi.encodeCall(
      DepositSubsidy.deployAndSweepForSubsidy,
      (SIPABase.Intent.Deposit, _recoveryCommitment("recovery"), true, address(underlying), relayer, _intentData, "")
    );
  }
}

contract DecimalMintableToken is MintableToken {
  function decimals() external pure returns (uint8) {
    return 18;
  }
}

contract EscrowPortal {
  IERC20 public immutable UNDERLYING;
  uint256 public immutable ROLLUP_VERSION;

  uint256 internal nextIndex;

  constructor(IERC20 _underlying, uint256 _rollupVersion) {
    UNDERLYING = _underlying;
    ROLLUP_VERSION = _rollupVersion;
  }

  function deposit(bytes32 _recipientCommitment, uint256 _amount)
    external
    returns (bytes32 key, uint256 index, uint256 creditedAmount)
  {
    UNDERLYING.transferFrom(msg.sender, address(this), _amount);
    index = nextIndex++;
    key = keccak256(abi.encode(_recipientCommitment, _amount, index));
    creditedAmount = _amount;
  }
}

contract DepositSubsidyMinCreditedAmountUsdcTest is Test {
  uint256 internal constant ROLLUP_VERSION = 7;
  uint256 internal constant AMOUNT_6DEC = 1000e6;
  uint256 internal constant CREDITED = AMOUNT_6DEC * 1e12 - DEPOSIT_FEE;
  bytes32 internal constant RECOVERY = bytes32(uint256(1));

  address internal owner = makeAddr("owner");
  address internal relayer = makeAddr("relayer");

  EscrowPortal internal daiPortal;
  SIPAFactory internal sipaFactory;
  DepositSubsidy internal sm;

  function setUp() public {
    vm.chainId(1);
    MockCurve3Pool threePool = StablecoinMocks.install();
    vm.etch(address(DAI), address(new DecimalMintableToken()).code);
    threePool.setRate(address(DAI), 1e30);
    MintableToken(address(DAI)).mint(address(THREE_POOL), 1_000_000e18);

    daiPortal = new EscrowPortal(DAI, ROLLUP_VERSION);
    sipaFactory = new SIPAFactory(owner);
    DepositSIPA implementation = new DepositSIPA(IOxidePortal(address(daiPortal)), DEPOSIT_FEE);
    vm.prank(owner);
    sipaFactory.bless(address(implementation));

    vm.fee(4e9);
    vm.txGasPrice(4e9);
    MockV3Aggregator feed = new MockV3Aggregator(8, 2500e8);
    sm = new DepositSubsidy(owner, address(daiPortal), AggregatorV3Interface(address(feed)), sipaFactory);
    MintableToken(address(DAI)).mint(address(sm), 1_000_000e18);
  }

  function test_GivenAUsdcCreditBelowTheMinimum_ThenTheSweepLandsWithoutASubsidy() external {
    _setMinCreditedAmount(CREDITED + 1);
    uint256 relayerBefore = DAI.balanceOf(relayer);

    uint256 subsidy = _deployAndSweepUsdc();

    assertEq(subsidy, 0, "a swapped credit under the minimum must not be subsidized");
    assertEq(DAI.balanceOf(address(daiPortal)), CREDITED, "the swapped deposit still bridged");
    assertEq(DAI.balanceOf(relayer) - relayerBefore, DEPOSIT_FEE, "the relayer keeps the fee");
  }

  function test_GivenAUsdcCreditAtTheMinimum_ThenItIsPaid() external {
    _setMinCreditedAmount(CREDITED);

    uint256 subsidy = _deployAndSweepUsdc();

    assertGt(subsidy, 0, "a swapped credit that meets the minimum must be paid");
    assertEq(DAI.balanceOf(address(daiPortal)), CREDITED, "the credit is measured in the portal token");
  }

  function _deployAndSweepUsdc() internal returns (uint256) {
    bytes memory intent = abi.encode(bytes32(uint256(2)));
    address sipa = sipaFactory.predictSIPA(
      sipaFactory.implementationFor(address(daiPortal), SIPABase.Intent.Deposit),
      keccak256(intent),
      RECOVERY,
      ROLLUP_VERSION,
      true
    );
    MintableToken(address(USDC)).mint(sipa, AMOUNT_6DEC);
    return sm.deployAndSweepForSubsidy(SIPABase.Intent.Deposit, RECOVERY, true, address(USDC), relayer, intent, "");
  }

  function _setMinCreditedAmount(uint256 _minCreditedAmount) internal {
    vm.prank(owner);
    sm.setDepositConfig(uint128(DEPOSIT_FEE), type(uint128).max, uint128(DEPOSIT_FEE), uint128(_minCreditedAmount), 0);
  }
}
