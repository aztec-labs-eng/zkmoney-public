// SPDX-License-Identifier: Apache-2.0
pragma solidity >=0.8.27;

import {TestERC20} from "@aztec/mock/TestERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {CCTPBridgeEscrow} from "@periphery/bridge_on_withdraw_feature/CCTPBridgeEscrow.sol";
import {CCTPBridgeEscrowFactory} from "@periphery/bridge_on_withdraw_feature/CCTPBridgeEscrowFactory.sol";
import {ICurve3Pool} from "@periphery/interfaces/ICurve3Pool.sol";
import {ITokenMessengerV2} from "@periphery/interfaces/ITokenMessengerV2.sol";
import {RecoveryCommitmentLib} from "@periphery/RecoveryCommitmentLib.sol";
import {EscrowRecoveryTestBase} from "@test/periphery/EscrowRecoveryTestBase.sol";
import {MockCurve3Pool} from "@test/mocks/MockCurve3Pool.sol";
import {MockTokenMessengerV2} from "@test/mocks/MockTokenMessengerV2.sol";

abstract contract CCTPBridgeEscrowTestBase is EscrowRecoveryTestBase {
  uint256 internal constant AMOUNT = 2500e18;
  uint256 internal constant TIP = 25e18;
  bytes32 internal constant NONCE = keccak256("nonce");

  uint256 internal constant USDC_RATE = 99e16;
  uint256 internal constant SWAPPED_USDC = ((AMOUNT - TIP) * USDC_RATE) / 1e18;
  uint256 internal constant MAX_FEE = 300_000;
  uint32 internal constant BASE_DOMAIN = 6;
  uint32 internal constant FAST_FINALITY = 1000;

  TestERC20 internal dai;
  TestERC20 internal usdc;
  MockCurve3Pool internal threePool;
  MockTokenMessengerV2 internal tokenMessenger;
  CCTPBridgeEscrowFactory internal factory;
  CCTPBridgeEscrow internal implementation;

  address internal hyperEvmCctpForwarder = makeAddr("hyperevm-cctp-forwarder");
  address internal relayer = makeAddr("relayer");
  address internal alice = makeAddr("alice");

  function setUp() public virtual override {
    super.setUp();

    dai = new TestERC20("DAI", "DAI", address(this));
    usdc = new TestERC20("USDC", "USDC", address(this));

    threePool = new MockCurve3Pool();
    threePool.setCoins(address(dai), address(usdc), makeAddr("usdt"));
    threePool.setRate(address(usdc), USDC_RATE);
    usdc.mint(address(threePool), 1_000_000e18);

    tokenMessenger = new MockTokenMessengerV2();

    factory = new CCTPBridgeEscrowFactory(
      IERC20(address(dai)),
      address(usdc),
      ICurve3Pool(address(threePool)),
      ITokenMessengerV2(address(tokenMessenger)),
      hyperEvmCctpForwarder
    );
    implementation = CCTPBridgeEscrow(factory.IMPLEMENTATION());
  }

  function _args(uint8 _route) internal view returns (CCTPBridgeEscrow.Args memory) {
    return CCTPBridgeEscrow.Args({
      route: _route,
      destinationDomain: _route == implementation.ROUTE_HYPERCORE_SPOT()
        ? implementation.HYPEREVM_DOMAIN()
        : BASE_DOMAIN,
      recipient: alice,
      minFinalityThreshold: FAST_FINALITY,
      maxFee: MAX_FEE,
      recoveryCommitment: RecoveryCommitmentLib.deriveRecoveryCommitment(RECOVERY_SALT, address(account)),
      relayerTip: TIP,
      nonce: NONCE
    });
  }

  function _fundAndDeploy(CCTPBridgeEscrow.Args memory _escrowArgs, uint256 _funding)
    internal
    returns (address escrow)
  {
    dai.mint(factory.predictEscrowAddress(_escrowArgs), _funding);
    vm.prank(relayer);
    escrow = factory.deployAndExecute(_escrowArgs);
  }
}
