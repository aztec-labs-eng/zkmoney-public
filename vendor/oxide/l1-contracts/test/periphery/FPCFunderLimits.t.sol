// SPDX-License-Identifier: Apache-2.0
pragma solidity >=0.8.27;
import {IERC20} from "@oz/token/ERC20/IERC20.sol";
import {IFeeJuicePortal} from "@aztec/core/interfaces/IFeeJuicePortal.sol";
import {IRegistry} from "@aztec/governance/interfaces/IRegistry.sol";
import {IFPCFunder} from "@periphery/interfaces/IFPCFunder.sol";
import {FPCFunderDAI} from "@periphery/fpc_funder/FPCFunderDAI.sol";
import {FPCFunderTestnet} from "@test/mocks/FPCFunderTestnet.sol";
import {AggregatorV3Interface} from "@periphery/interfaces/AggregatorV3Interface.sol";
import {Errors} from "@periphery/Errors.sol";
import {MockCurve3Pool} from "@test/mocks/MockCurve3Pool.sol";
import {FPCFunderBase, MintableToken, MockUniversalRouter} from "./FPCFunderDAI.t.sol";

contract ReentrantFundingPortal {
  bytes public reentryError;

  function depositToAztecPublic(bytes32, uint256 _amount, bytes32) external returns (bytes32, uint256) {
    (bool success, bytes memory errorData) = msg.sender.call(abi.encodeCall(IFPCFunder.swapAndDepositAsFeeJuice, ()));
    require(!success, "Reentry succeeded");
    reentryError = errorData;
    IFPCFunder(msg.sender).FEE_ASSET().transferFrom(msg.sender, address(this), _amount);
    return (bytes32(uint256(0xAB)), 7);
  }
}

abstract contract FPCFunderLimitsTest is FPCFunderBase {
  uint256 internal constant FUNDING_CAP = 500e18;
  IFPCFunder internal funder;
  MintableToken internal token;

  function setUp() public virtual override {
    super.setUp();
    funder = _deployFunder();
    token = MintableToken(address(funder.inputToken()));
    vm.roll(block.number + 1);
  }

  function _deployFunder() internal virtual returns (IFPCFunder);

  function testFuzz_CappedSpendAndBounty(uint256 _balance, uint256 _elapsed) external {
    _balance = bound(_balance, MIN_FUNDABLE_BALANCE, type(uint128).max);
    _elapsed = bound(_elapsed, 0, 2 * BOUNTY_RAMP_DURATION);
    token.mint(address(funder), _balance);
    vm.warp(block.timestamp + _elapsed);
    ethUsdFeed.setUpdatedAt(block.timestamp);

    uint256 expectedSpend = _balance > FUNDING_CAP ? FUNDING_CAP : _balance;
    uint256 bps = _elapsed >= BOUNTY_RAMP_DURATION
      ? MAX_BOUNTY_BPS
      : MIN_BOUNTY_BPS + ((MAX_BOUNTY_BPS - MIN_BOUNTY_BPS) * _elapsed) / BOUNTY_RAMP_DURATION;
    (uint256 balance, uint256 bounty) = funder.quoteBalanceAndBounty();
    assertEq(balance, expectedSpend);
    assertEq(bounty, expectedSpend * bps / 10_000);

    funder.swapAndDepositAsFeeJuice();

    assertEq(token.balanceOf(address(funder)), _balance - expectedSpend);
    assertEq(token.balanceOf(address(this)), bounty);
    assertEq(feeAsset.balanceOf(address(feeJuicePortal)), expectedSpend - bounty);
  }

  function test_BlockLimitAppliesAcrossCallersAndNewFunds() external {
    token.mint(address(funder), 10_000e18);
    funder.swapAndDepositAsFeeJuice();
    token.mint(address(funder), 100e18);
    vm.warp(block.timestamp + BOUNTY_RAMP_DURATION);

    (uint256 balance, uint256 bounty) = funder.quoteBalanceAndBounty();
    assertEq(balance, 0);
    assertEq(bounty, 0);
    vm.prank(makeAddr("second-caller"));
    vm.expectRevert(Errors.FPCFunder__AlreadyFundedThisBlock.selector);
    funder.swapAndDepositAsFeeJuice();
    assertEq(token.balanceOf(address(funder)), 9600e18);
  }

  function test_ExcessDrainsAcrossBlocksAndLeavesDust() external {
    token.mint(address(funder), 2 * FUNDING_CAP + MIN_FUNDABLE_BALANCE - 1);
    funder.swapAndDepositAsFeeJuice();
    vm.roll(block.number + 1);
    (uint256 balance, uint256 bounty) = funder.quoteBalanceAndBounty();
    assertEq(balance, FUNDING_CAP);
    assertEq(bounty, FUNDING_CAP * MIN_BOUNTY_BPS / 10_000);
    funder.swapAndDepositAsFeeJuice();
    assertEq(token.balanceOf(address(funder)), MIN_FUNDABLE_BALANCE - 1);

    vm.roll(block.number + 1);
    (balance, bounty) = funder.quoteBalanceAndBounty();
    assertEq(balance, MIN_FUNDABLE_BALANCE - 1);
    assertEq(bounty, 0);
    vm.expectRevert(
      abi.encodeWithSelector(
        Errors.FPCFunder__BalanceBelowMinimum.selector, MIN_FUNDABLE_BALANCE - 1, MIN_FUNDABLE_BALANCE
      )
    );
    funder.swapAndDepositAsFeeJuice();

    token.mint(address(funder), 1);
    funder.swapAndDepositAsFeeJuice();
    assertEq(token.balanceOf(address(funder)), 0);
  }

  function test_FailedDepositPreservesBlockAllowanceAndBounty() external {
    token.mint(address(funder), 10_000e18);
    vm.warp(block.timestamp + BOUNTY_RAMP_DURATION);
    ethUsdFeed.setUpdatedAt(block.timestamp);
    (uint256 balance, uint256 bounty) = funder.quoteBalanceAndBounty();
    assertEq(bounty, 50e18);
    bytes memory failure = abi.encodeWithSignature("DepositFailed()");
    vm.mockCallRevert(
      address(feeJuicePortal), abi.encodeWithSelector(IFeeJuicePortal.depositToAztecPublic.selector), failure
    );
    vm.expectRevert(failure);
    funder.swapAndDepositAsFeeJuice();
    assertEq(token.balanceOf(address(funder)), 10_000e18);
    assertEq(token.balanceOf(address(this)), 0);
    (uint256 balanceAfter, uint256 bountyAfter) = funder.quoteBalanceAndBounty();
    assertEq(balanceAfter, balance);
    assertEq(bountyAfter, bounty);

    vm.clearMockedCalls();
    funder.swapAndDepositAsFeeJuice();
    assertEq(token.balanceOf(address(this)), bounty);
    assertEq(token.balanceOf(address(funder)), 9500e18);
  }

  function test_ReentryCannotSpendAnotherChunk() external {
    ReentrantFundingPortal portal = new ReentrantFundingPortal();
    rollup.setFeeAssetPortal(IFeeJuicePortal(address(portal)));
    funder = _deployFunder();
    vm.roll(block.number + 1);
    token.mint(address(funder), 10_000e18);

    funder.swapAndDepositAsFeeJuice();

    assertEq(portal.reentryError(), abi.encodeWithSelector(Errors.FPCFunder__AlreadyFundedThisBlock.selector));
    assertEq(token.balanceOf(address(funder)), 9500e18);
  }

  function test_FirstFundingRequiresLaterBlock() external {
    funder = _deployFunder();
    token.mint(address(funder), FUNDING_CAP);
    (uint256 balance, uint256 bounty) = funder.quoteBalanceAndBounty();
    assertEq(balance, 0);
    assertEq(bounty, 0);
    vm.expectRevert(Errors.FPCFunder__AlreadyFundedThisBlock.selector);
    funder.swapAndDepositAsFeeJuice();
    assertEq(token.balanceOf(address(funder)), FUNDING_CAP);

    vm.roll(block.number + 1);
    funder.swapAndDepositAsFeeJuice();
    assertEq(token.balanceOf(address(funder)), 0);
    assertEq(token.balanceOf(address(this)), FUNDING_CAP * MIN_BOUNTY_BPS / 10_000);
  }
}

contract FPCFunderDAILimitsTest is FPCFunderLimitsTest {
  function _deployFunder() internal override returns (IFPCFunder) {
    address dai = 0x6B175474E89094C44Da98b954EedeAC495271d0F;
    address usdc = 0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48;
    address threePool = 0xbEbc44782C7dB0a1A60Cb6fe97d0b483032FF1C7;
    address router = 0x66a9893cC07D91D95644AEDD05D03f95e1dBA8Af;
    vm.etch(dai, address(new MintableToken()).code);
    vm.etch(usdc, address(new MintableToken()).code);
    vm.etch(threePool, address(new MockCurve3Pool()).code);
    MockCurve3Pool(threePool).setCoins(dai, usdc, address(0));
    MockCurve3Pool(threePool).setRate(usdc, 1e18);
    MintableToken(usdc).mint(threePool, 1_000_000e18);
    vm.etch(router, address(new MockUniversalRouter(usdc, FEE_ASSET)).code);
    return new FPCFunderDAI(
      IRegistry(address(registry)), ROLLUP_VERSION, BENEFICIARY, AggregatorV3Interface(address(ethUsdFeed))
    );
  }
}

contract FPCFunderTestnetLimitsTest is FPCFunderLimitsTest {
  function _deployFunder() internal override returns (IFPCFunder) {
    address input = address(0x3333);
    vm.etch(input, address(new MintableToken()).code);
    vm.etch(0x3A9D48AB9751398BbFa63ad67599Bb04e4BdF98b, address(new MockUniversalRouter(input, FEE_ASSET)).code);
    return new FPCFunderTestnet(IRegistry(address(registry)), ROLLUP_VERSION, BENEFICIARY, IERC20(input));
  }
}
