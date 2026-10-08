// SPDX-License-Identifier: Apache-2.0
pragma solidity >=0.8.27;
import {IERC20 as OzIERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {AcrossBridgeEscrow} from "@periphery/bridge_on_withdraw_feature/AcrossBridgeEscrow.sol";
import {AcrossBridgeEscrowFactory} from "@periphery/bridge_on_withdraw_feature/AcrossBridgeEscrowFactory.sol";
import {IAcrossSpokePool} from "@periphery/interfaces/IAcrossSpokePool.sol";
import {DAI, USDC, USDT, THREE_POOL} from "@periphery/ThreePoolLib.sol";

import {MainnetForkFixture} from "@test/fork/MainnetForkFixture.sol";

contract AcrossBridgeEscrowForkTest is MainnetForkFixture {
  IAcrossSpokePool internal constant SPOKE_POOL = IAcrossSpokePool(0x5c7BCd6E7De5423a257D81B442095A1a6ced35C5);
  address internal constant ARBITRUM_USDC = 0xaf88d065e77c8cC2239327C5EDb3A432268e5831;
  address internal constant ARBITRUM_USDT = 0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9;

  uint256 internal constant AMOUNT = 2500e18;
  uint256 internal constant TIP = 5e18;
  uint256 internal constant ACROSS_FEE = 1e6;
  uint256 internal constant INPUT_BAND_LOW = 2470e6;
  uint256 internal constant INPUT_BAND_HIGH = 2500e6;
  uint256 internal constant ARBITRUM_CHAIN_ID = 42_161;
  uint8 internal constant ARBITRUM_STABLE_DECIMALS = 6;

  AcrossBridgeEscrowFactory internal factory;
  address internal relayer = makeAddr("relayer");
  address internal recipient = makeAddr("recipient");

  function setUp() public override {
    _selectMainnetFork();
    factory =
      new AcrossBridgeEscrowFactory(OzIERC20(address(DAI)), address(USDC), address(USDT), THREE_POOL, SPOKE_POOL);
  }

  function test_GivenUsdtAcrossInput_WhenDeployed_ThenRealSpokePoolTakesNearParityUsdt() external {
    _assertDepositsNearParity(OzIERC20(address(USDT)), ARBITRUM_USDT);
  }

  function test_GivenUsdcAcrossInput_WhenDeployed_ThenRealSpokePoolTakesNearParityUsdc() external {
    _assertDepositsNearParity(OzIERC20(address(USDC)), ARBITRUM_USDC);
  }

  function _assertDepositsNearParity(OzIERC20 _acrossInputToken, address _acrossOutputToken) internal {
    AcrossBridgeEscrow.Args memory args = AcrossBridgeEscrow.Args({
      acrossInputToken: address(_acrossInputToken),
      destinationChainId: ARBITRUM_CHAIN_ID,
      recipient: recipient,
      acrossOutputToken: _acrossOutputToken,
      acrossOutputTokenDecimals: ARBITRUM_STABLE_DECIMALS,
      acrossFee: ACROSS_FEE,
      recoveryCommitment: keccak256("recovery"),
      relayerTip: TIP,
      nonce: keccak256("fork-nonce")
    });
    address escrow = factory.predictEscrowAddress(args);
    deal(address(DAI), escrow, AMOUNT);
    uint256 inputAmount = _swappedAmount(args);
    assertGt(inputAmount, INPUT_BAND_LOW);
    assertLt(inputAmount, INPUT_BAND_HIGH);

    vm.expectEmit(true, false, true, true, address(SPOKE_POOL));
    emit IAcrossSpokePool.FundsDeposited(
      _toBytes32(address(_acrossInputToken)),
      _toBytes32(_acrossOutputToken),
      inputAmount,
      inputAmount - ACROSS_FEE,
      ARBITRUM_CHAIN_ID,
      0,
      uint32(block.timestamp),
      uint32(block.timestamp) + AcrossBridgeEscrow(factory.IMPLEMENTATION()).FILL_DEADLINE_OFFSET(),
      0,
      _toBytes32(escrow),
      _toBytes32(recipient),
      bytes32(0),
      ""
    );
    vm.prank(relayer);
    factory.deployAndExecute(args);

    assertEq(DAI.balanceOf(relayer), TIP);
    assertEq(DAI.balanceOf(escrow), 0);
    assertEq(_acrossInputToken.balanceOf(escrow), 0);
  }

  function _swappedAmount(AcrossBridgeEscrow.Args memory _args) internal returns (uint256 inputAmount) {
    uint256 snapshot = vm.snapshotState();
    uint256 spokePoolBefore = OzIERC20(_args.acrossInputToken).balanceOf(address(SPOKE_POOL));
    vm.prank(relayer);
    factory.deployAndExecute(_args);
    inputAmount = OzIERC20(_args.acrossInputToken).balanceOf(address(SPOKE_POOL)) - spokePoolBefore;
    vm.revertToState(snapshot);
  }

  function _toBytes32(address _address) internal pure returns (bytes32) {
    return bytes32(uint256(uint160(_address)));
  }
}
