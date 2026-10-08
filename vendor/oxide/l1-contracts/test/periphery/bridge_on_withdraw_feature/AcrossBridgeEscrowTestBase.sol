// SPDX-License-Identifier: Apache-2.0
pragma solidity >=0.8.27;

import {TestERC20} from "@aztec/mock/TestERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {AcrossBridgeEscrow} from "@periphery/bridge_on_withdraw_feature/AcrossBridgeEscrow.sol";
import {AcrossBridgeEscrowFactory} from "@periphery/bridge_on_withdraw_feature/AcrossBridgeEscrowFactory.sol";
import {ICurve3Pool} from "@periphery/interfaces/ICurve3Pool.sol";
import {IAcrossSpokePool} from "@periphery/interfaces/IAcrossSpokePool.sol";
import {RecoveryCommitmentLib} from "@periphery/RecoveryCommitmentLib.sol";
import {EscrowRecoveryTestBase} from "@test/periphery/EscrowRecoveryTestBase.sol";
import {MockAcrossSpokePool} from "./MockAcrossSpokePool.sol";
import {MockCurve3Pool} from "@test/mocks/MockCurve3Pool.sol";

abstract contract AcrossBridgeEscrowTestBase is EscrowRecoveryTestBase {
  uint256 internal constant AMOUNT = 2500e18;
  uint256 internal constant TIP = 25e18;
  bytes32 internal constant NONCE = keccak256("nonce");

  uint256 internal constant STABLE_RATE = 1e6;
  uint256 internal constant SWAPPED_AMOUNT = ((AMOUNT - TIP) * STABLE_RATE) / 1e18;
  uint256 internal constant ACROSS_FEE = 300_000;
  uint256 internal constant ARBITRUM_CHAIN_ID = 42_161;
  uint8 internal constant ARBITRUM_USDT_DECIMALS = 6;

  TestERC20 internal dai;
  TestERC20 internal usdc;
  TestERC20 internal usdt;
  MockCurve3Pool internal threePool;
  MockAcrossSpokePool internal spokePool;
  AcrossBridgeEscrowFactory internal factory;
  AcrossBridgeEscrow internal implementation;

  address internal arbitrumUsdt = makeAddr("arbitrum-usdt");
  address internal relayer = makeAddr("relayer");
  address internal alice = makeAddr("alice");

  function setUp() public virtual override {
    super.setUp();

    dai = new TestERC20("DAI", "DAI", address(this));
    usdc = new TestERC20("USDC", "USDC", address(this));
    usdt = new TestERC20("USDT", "USDT", address(this));

    threePool = new MockCurve3Pool();
    threePool.setCoins(address(dai), address(usdc), address(usdt));
    threePool.setRate(address(usdc), STABLE_RATE);
    threePool.setRate(address(usdt), STABLE_RATE);
    usdc.mint(address(threePool), 1_000_000e18);
    usdt.mint(address(threePool), 1_000_000e18);

    spokePool = new MockAcrossSpokePool();

    factory = new AcrossBridgeEscrowFactory(
      IERC20(address(dai)),
      address(usdc),
      address(usdt),
      ICurve3Pool(address(threePool)),
      IAcrossSpokePool(address(spokePool))
    );
    implementation = AcrossBridgeEscrow(factory.IMPLEMENTATION());
  }

  function _args() internal view returns (AcrossBridgeEscrow.Args memory) {
    return AcrossBridgeEscrow.Args({
      acrossInputToken: address(usdt),
      destinationChainId: ARBITRUM_CHAIN_ID,
      recipient: alice,
      acrossOutputToken: arbitrumUsdt,
      acrossOutputTokenDecimals: ARBITRUM_USDT_DECIMALS,
      acrossFee: ACROSS_FEE,
      recoveryCommitment: RecoveryCommitmentLib.deriveRecoveryCommitment(RECOVERY_SALT, address(account)),
      relayerTip: TIP,
      nonce: NONCE
    });
  }

  function _fundAndDeploy(AcrossBridgeEscrow.Args memory _escrowArgs, uint256 _funding)
    internal
    returns (address escrow)
  {
    dai.mint(factory.predictEscrowAddress(_escrowArgs), _funding);
    vm.prank(relayer);
    escrow = factory.deployAndExecute(_escrowArgs);
  }
}
