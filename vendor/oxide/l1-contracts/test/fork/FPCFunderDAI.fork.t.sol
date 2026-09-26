// SPDX-License-Identifier: Apache-2.0
pragma solidity >=0.8.27;
import {Vm} from "forge-std/Vm.sol";
import {console2} from "forge-std/console2.sol";
import {IERC20} from "@oz/token/ERC20/IERC20.sol";
import {IERC20 as OzIERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IRegistry} from "@aztec/governance/interfaces/IRegistry.sol";

import {DAI} from "@periphery/ThreePoolLib.sol";
import {FPCFunderDAI} from "@periphery/fpc_funder/FPCFunderDAI.sol";
import {AggregatorV3Interface} from "@periphery/interfaces/AggregatorV3Interface.sol";
import {IFPCFunder} from "@periphery/interfaces/IFPCFunder.sol";
import {OperationExecutor} from "@periphery/OperationExecutor.sol";

import {MainnetForkFixture} from "@test/fork/MainnetForkFixture.sol";

contract FPCFunderDAIForkTest is MainnetForkFixture {
  IRegistry internal constant AZTEC_REGISTRY = IRegistry(0x35b22e09Ee0390539439E24f06Da43D83f90e298);
  uint256 internal constant AZTEC_ROLLUP_VERSION = 4_248_422_647;
  address internal constant AZTEC_FEE_ASSET = 0xA27EC0006e59f245217Ff08CD52A7E8b169E62D2;
  address internal constant UNIVERSAL_ROUTER = 0x66a9893cC07D91D95644AEDD05D03f95e1dBA8Af;
  address internal constant WETH = 0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2;
  AggregatorV3Interface internal constant ETH_USD_FEED =
    AggregatorV3Interface(0x5f4eC3Df9cbd43714FE2740f5E3616155c5b8419);

  bytes32 internal constant BENEFICIARY = bytes32(uint256(0xFBC));
  uint256 internal constant FUNDED_BALANCE = 1000e18;

  uint256 internal constant CAPPED_BALANCE = 500e18;

  uint256 internal constant DEPOSIT_BAND_LOW = 35_500e18;
  uint256 internal constant DEPOSIT_BAND_HIGH = 37_750e18;

  FPCFunderDAI internal funder;
  OperationExecutor internal executor;

  function setUp() public override {
    _selectMainnetFork();
    funder = new FPCFunderDAI(AZTEC_REGISTRY, AZTEC_ROLLUP_VERSION, BENEFICIARY, ETH_USD_FEED);
    executor = new OperationExecutor();
    deal(address(DAI), address(funder), FUNDED_BALANCE);
    vm.roll(block.number + 1);
  }

  function test_ConstructorResolvesLiveAztecDeployment() external view {
    assertEq(address(funder.FEE_ASSET()), AZTEC_FEE_ASSET);
    assertEq(address(funder.FEE_JUICE_PORTAL()), 0xaf73Dd51D1eb8a079BB097f39c832cDD00ac691c);
  }

  function test_GivenDaiBalance_WhenFunded_ThenFeeJuiceDepositedThroughRealRoute() external {
    (uint256 balance, uint256 bounty) = funder.quoteBalanceAndBounty();
    assertEq(balance, CAPPED_BALANCE);
    assertEq(bounty, (CAPPED_BALANCE * 1) / 10_000);
    IERC20 feeAsset = funder.FEE_ASSET();
    address portal = address(funder.FEE_JUICE_PORTAL());
    uint256 portalBefore = feeAsset.balanceOf(portal);

    (bytes32 key,) = funder.swapAndDepositAsFeeJuice();

    assertNotEq(key, bytes32(0));
    uint256 deposited = feeAsset.balanceOf(portal) - portalBefore;
    assertGt(deposited, DEPOSIT_BAND_LOW);
    assertLt(deposited, DEPOSIT_BAND_HIGH);
    assertEq(DAI.balanceOf(address(this)), bounty);
    assertEq(DAI.balanceOf(address(funder)), FUNDED_BALANCE - CAPPED_BALANCE);
    assertEq(feeAsset.balanceOf(address(funder)), 0);
    assertEq(IERC20(WETH).balanceOf(UNIVERSAL_ROUTER), 0);
    assertEq(UNIVERSAL_ROUTER.balance, 0);
  }

  function test_GivenExecutorPath_WhenFunded_ThenBountySweptToCaller() external {
    (, uint256 bounty) = funder.quoteBalanceAndBounty();

    uint256 payout = executor.execute(
      address(funder), abi.encodeCall(IFPCFunder.swapAndDepositAsFeeJuice, ()), OzIERC20(address(DAI)), bounty
    );

    assertEq(payout, bounty);
    assertEq(DAI.balanceOf(address(this)), bounty);
    assertEq(DAI.balanceOf(address(executor)), 0);
  }

  function test_MeasureFundGasDirect() external {
    funder.swapAndDepositAsFeeJuice();
    console2.log("swapAndDepositAsFeeJuice direct, cold net gas", _lastCallNetGas());
  }

  function test_MeasureFundGasViaExecutor() external {
    executor.execute(
      address(funder), abi.encodeCall(IFPCFunder.swapAndDepositAsFeeJuice, ()), OzIERC20(address(DAI)), 0
    );
    console2.log("swapAndDepositAsFeeJuice via executor, cold net gas", _lastCallNetGas());
  }

  function _lastCallNetGas() internal view returns (uint256) {
    Vm.Gas memory g = vm.lastCallGas();
    return uint256(int256(uint256(g.gasTotalUsed)) - int256(g.gasRefunded));
  }
}
