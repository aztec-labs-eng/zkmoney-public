// SPDX-License-Identifier: Apache-2.0
pragma solidity >=0.8.27;

import {Test} from "forge-std/Test.sol";
import {TestERC20} from "@aztec/mock/TestERC20.sol";
import {Hash} from "@aztec/core/libraries/crypto/Hash.sol";
import {IOxidePortal} from "@core/interfaces/IOxidePortal.sol";
import {StablecoinWithdrawalExecutor} from "@periphery/StablecoinWithdrawalExecutor.sol";
import {IExecutor} from "@core/interfaces/IExecutor.sol";
import {PlainWithdrawalSubsidy} from "@periphery/PlainWithdrawalSubsidy.sol";
import {AggregatorV3Interface} from "@periphery/interfaces/AggregatorV3Interface.sol";
import {Errors} from "@periphery/Errors.sol";
import {MockV3Aggregator} from "@test/mocks/MockV3Aggregator.sol";

contract StablecoinWithdrawalExecutorTest is Test {
  TestERC20 internal asset;
  AggregatorV3Interface internal priceFeed;
  StablecoinWithdrawalExecutor internal executor;
  PlainWithdrawalSubsidy internal subsidy;
  address internal constant PORTAL = address(0xA11CE);
  address internal constant OWNER = address(0x0B0B);
  address internal constant RECIPIENT = address(0xBEEF);
  address internal constant TIP_RECIPIENT = address(0xCAFE);
  address internal constant BENEFICIARY = address(0xFEE);

  IExecutor.Flow internal constant WITHDRAWAL = IExecutor.Flow.Withdrawal;
  uint8 internal constant ROUTE_DAI = 2;

  function setUp() external {
    asset = new TestERC20("Test", "TST", address(this));
    _mockPortal(PORTAL, address(asset));
    priceFeed = AggregatorV3Interface(address(new MockV3Aggregator(8, 2500e8)));
    executor = new StablecoinWithdrawalExecutor(PORTAL, 0, address(0), OWNER, priceFeed);
    subsidy = executor.SUBSIDY();
  }

  function testExecutesCanonicalPayload() external {
    asset.mint(address(executor), 10 ether);
    vm.prank(PORTAL);
    executor.execute(WITHDRAWAL, 10 ether, _daiPayload(RECIPIENT, 3 ether), abi.encodePacked(TIP_RECIPIENT));
    assertEq(asset.balanceOf(RECIPIENT), 7 ether);
    assertEq(asset.balanceOf(TIP_RECIPIENT), 3 ether);
  }

  function testDecodesThePayloadVectorThatOxideLibEncodes() external {
    bytes memory userPayload =
      hex"0211223344556677889900aabbccddeeff00112233000000000000000000000000000000000000000000000000000000000000000000ababababababababababababababababababababababababababababababab000000000000000000000000047d411b";
    address vectorRecipient = 0x11223344556677889900aABbCcdDEeFF00112233;
    assertEq(
      userPayload,
      abi.encodePacked(
        ROUTE_DAI,
        vectorRecipient,
        uint128(0),
        uint128(0),
        bytes32(0x00ababababababababababababababababababababababababababababababab),
        uint128(75_317_531)
      )
    );
    assertEq(Hash.sha256ToField(userPayload), 0x00a0d457a9e6bccf6b9e7c51b3421c1cc44edd70393c9d06359254e42911488c);

    asset.mint(address(executor), 100_000_000);
    vm.prank(PORTAL);
    executor.execute(WITHDRAWAL, 100_000_000, userPayload, abi.encodePacked(TIP_RECIPIENT));

    assertEq(asset.balanceOf(vectorRecipient), 100_000_000 - 75_317_531);
    assertEq(asset.balanceOf(TIP_RECIPIENT), 75_317_531);
  }

  function testPreservesDonation() external {
    asset.mint(address(executor), 12 ether);
    vm.prank(PORTAL);
    executor.execute(WITHDRAWAL, 10 ether, _daiPayload(RECIPIENT, 0), abi.encodePacked(address(0)));
    assertEq(asset.balanceOf(address(executor)), 2 ether);
  }

  function testRejectsNonCanonicalUserPayload() external {
    vm.prank(PORTAL);
    vm.expectRevert(Errors.StablecoinWithdrawalExecutor__InvalidUserPayload.selector);
    executor.execute(WITHDRAWAL, 1 ether, hex"00", abi.encodePacked(address(0)));
  }

  function testRejectsRelayerPayloadThatNamesASubsidy() external {
    vm.prank(PORTAL);
    vm.expectRevert(Errors.StablecoinWithdrawalExecutor__InvalidRelayerPayload.selector);
    executor.execute(WITHDRAWAL, 1 ether, _daiPayload(RECIPIENT, 0), abi.encodePacked(TIP_RECIPIENT, address(subsidy)));
  }

  function testRevertingWithdrawalSubsidyRollsBack() external {
    asset.mint(address(executor), 10 ether);
    vm.mockCallRevert(address(subsidy), abi.encodeWithSelector(PlainWithdrawalSubsidy.paySubsidy.selector), "");
    vm.prank(PORTAL);
    vm.expectRevert();
    executor.execute(WITHDRAWAL, 10 ether, _daiPayload(RECIPIENT, 1 ether), abi.encodePacked(TIP_RECIPIENT));
    assertEq(asset.balanceOf(address(executor)), 10 ether);
    assertEq(asset.balanceOf(RECIPIENT), 0);
    assertEq(asset.balanceOf(TIP_RECIPIENT), 0);
  }

  function testRejectsTipWithoutRecipient() external {
    asset.mint(address(executor), 10 ether);
    vm.prank(PORTAL);
    vm.expectRevert(Errors.StablecoinWithdrawalExecutor__ZeroTipRecipient.selector);
    executor.execute(WITHDRAWAL, 10 ether, _daiPayload(RECIPIENT, 1 ether), abi.encodePacked(address(0)));
  }

  function testClaimsNoSubsidyWithoutTipRecipient() external {
    asset.mint(address(executor), 10 ether);
    vm.expectCall(address(subsidy), abi.encodeWithSelector(PlainWithdrawalSubsidy.paySubsidy.selector), 0);
    vm.prank(PORTAL);
    executor.execute(WITHDRAWAL, 10 ether, _daiPayload(RECIPIENT, 0), abi.encodePacked(address(0)));
    assertEq(asset.balanceOf(RECIPIENT), 10 ether);
  }

  function testForwardsTheCallingFlowToTheWithdrawalSubsidy() external {
    asset.mint(address(executor), 10 ether);
    vm.expectCall(
      address(subsidy),
      abi.encodeCall(PlainWithdrawalSubsidy.paySubsidy, (IExecutor.Flow.FrozenNotesRefund, TIP_RECIPIENT))
    );
    vm.prank(PORTAL);
    executor.execute(
      IExecutor.Flow.FrozenNotesRefund, 10 ether, _daiPayload(RECIPIENT, 1 ether), abi.encodePacked(TIP_RECIPIENT)
    );
  }

  function testPaysTheWithdrawalSubsidyToTheTipRecipient() external {
    vm.prank(OWNER);
    subsidy.setFlowPricing(WITHDRAWAL, PlainWithdrawalSubsidy.FlowPricing({startPriceWei: 0, maxSubsidy: 100 ether}));
    asset.mint(address(subsidy), 100 ether);
    asset.mint(address(executor), 10 ether);
    vm.fee(10 gwei);
    vm.txGasPrice(10 gwei);
    uint256 quoted = subsidy.quoteSubsidy(WITHDRAWAL);
    assertGt(quoted, 0, "the subsidy must quote a payout");

    vm.prank(PORTAL);
    executor.execute(WITHDRAWAL, 10 ether, _daiPayload(RECIPIENT, 1 ether), abi.encodePacked(TIP_RECIPIENT));

    assertEq(asset.balanceOf(RECIPIENT), 9 ether);
    assertEq(asset.balanceOf(TIP_RECIPIENT), 1 ether + quoted);
  }

  function testPaysTheFeeBeforeTheTipAndTheRecipient() external {
    StablecoinWithdrawalExecutor charging =
      new StablecoinWithdrawalExecutor(PORTAL, 1 ether, BENEFICIARY, OWNER, priceFeed);
    asset.mint(address(charging), 10 ether);
    vm.prank(PORTAL);
    charging.execute(WITHDRAWAL, 10 ether, _daiPayload(RECIPIENT, 3 ether), abi.encodePacked(TIP_RECIPIENT));
    assertEq(asset.balanceOf(BENEFICIARY), 1 ether);
    assertEq(asset.balanceOf(TIP_RECIPIENT), 3 ether);
    assertEq(asset.balanceOf(RECIPIENT), 6 ether);
  }

  function testRejectsATipAboveTheAmountAfterTheFee() external {
    StablecoinWithdrawalExecutor charging =
      new StablecoinWithdrawalExecutor(PORTAL, 1 ether, BENEFICIARY, OWNER, priceFeed);
    asset.mint(address(charging), 10 ether);
    vm.prank(PORTAL);
    vm.expectRevert(Errors.StablecoinWithdrawalExecutor__RelayerTipExceedsAmount.selector);
    charging.execute(WITHDRAWAL, 10 ether, _daiPayload(RECIPIENT, 9.5 ether), abi.encodePacked(TIP_RECIPIENT));
  }

  function testCreatesAWithdrawalSubsidyBoundToItself() external view {
    assertEq(subsidy.EXECUTOR(), address(executor));
    assertEq(address(subsidy.TOKEN()), address(asset));
    assertEq(address(subsidy.PRICE_FEED()), address(priceFeed));
    assertEq(subsidy.owner(), OWNER);
    assertEq(address(subsidy), vm.computeCreateAddress(address(executor), 1));
  }

  function _daiPayload(address _recipient, uint256 _relayerTip) private pure returns (bytes memory) {
    return abi.encodePacked(ROUTE_DAI, _recipient, uint128(0), uint128(0), bytes32(0), uint128(_relayerTip));
  }

  function _mockPortal(address _portal, address _underlying) private {
    vm.etch(_portal, hex"00");
    vm.mockCall(_portal, abi.encodeWithSelector(IOxidePortal.UNDERLYING.selector), abi.encode(_underlying));
  }
}
