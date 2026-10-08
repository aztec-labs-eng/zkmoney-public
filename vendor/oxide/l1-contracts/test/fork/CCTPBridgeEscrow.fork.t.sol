// SPDX-License-Identifier: Apache-2.0
pragma solidity >=0.8.27;
import {IERC20 as OzIERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Vm} from "forge-std/Vm.sol";

import {CCTPBridgeEscrow} from "@periphery/bridge_on_withdraw_feature/CCTPBridgeEscrow.sol";
import {CCTPBridgeEscrowFactory} from "@periphery/bridge_on_withdraw_feature/CCTPBridgeEscrowFactory.sol";
import {ITokenMessengerV2} from "@periphery/interfaces/ITokenMessengerV2.sol";
import {DAI, USDC, THREE_POOL} from "@periphery/ThreePoolLib.sol";

import {MainnetForkFixture} from "@test/fork/MainnetForkFixture.sol";

contract CCTPBridgeEscrowForkTest is MainnetForkFixture {
  ITokenMessengerV2 internal constant TOKEN_MESSENGER = ITokenMessengerV2(0x28b5a0e9C621a5BadaA536219b3a228C8168cf5d);
  address internal constant HYPEREVM_CCTP_FORWARDER = 0xb21D281DEdb17AE5B501F6AA8256fe38C4e45757;
  bytes32 internal constant DEPOSIT_FOR_BURN_TOPIC =
    keccak256("DepositForBurn(address,uint256,address,bytes32,uint32,bytes32,bytes32,uint256,uint32,bytes)");

  uint256 internal constant AMOUNT = 2500e18;
  uint256 internal constant TIP = 5e18;
  uint256 internal constant MAX_FEE = 1e6;
  uint256 internal constant USDC_OUT_BAND_LOW = 2470e6;
  uint256 internal constant USDC_OUT_BAND_HIGH = 2500e6;
  uint32 internal constant BASE_DOMAIN = 6;
  uint32 internal constant FAST_FINALITY = 1000;

  CCTPBridgeEscrowFactory internal factory;
  CCTPBridgeEscrow internal implementation;
  address internal relayer = makeAddr("relayer");
  address internal recipient = makeAddr("recipient");

  function setUp() public override {
    _selectMainnetFork();
    factory = new CCTPBridgeEscrowFactory(
      OzIERC20(address(DAI)), address(USDC), THREE_POOL, TOKEN_MESSENGER, HYPEREVM_CCTP_FORWARDER
    );
    implementation = CCTPBridgeEscrow(factory.IMPLEMENTATION());
  }

  function test_GivenFundedEscrow_WhenDeployed_ThenRealMessengerBurnsNearParityUsdc() external {
    CCTPBridgeEscrow.Args memory args = CCTPBridgeEscrow.Args({
      route: implementation.ROUTE_DIRECT(),
      destinationDomain: BASE_DOMAIN,
      recipient: recipient,
      minFinalityThreshold: FAST_FINALITY,
      maxFee: MAX_FEE,
      recoveryCommitment: keccak256("recovery"),
      relayerTip: TIP,
      nonce: keccak256("fork-nonce")
    });
    address escrow = factory.predictEscrowAddress(args);
    deal(address(DAI), escrow, AMOUNT);
    uint256 supplyBefore = USDC.totalSupply();

    vm.recordLogs();
    vm.prank(relayer);
    factory.deployAndExecute(args);
    (address burnToken, address depositor, uint256 amount) = _depositForBurn(vm.getRecordedLogs());

    assertEq(burnToken, address(USDC));
    assertEq(depositor, escrow);
    assertGt(amount, USDC_OUT_BAND_LOW);
    assertLt(amount, USDC_OUT_BAND_HIGH);
    assertEq(USDC.totalSupply(), supplyBefore - amount);
    assertEq(DAI.balanceOf(relayer), TIP);
    assertEq(DAI.balanceOf(escrow), 0);
    assertEq(USDC.balanceOf(escrow), 0);
    assertEq(USDC.balanceOf(address(TOKEN_MESSENGER)), 0);
  }

  function _depositForBurn(Vm.Log[] memory _logs)
    internal
    pure
    returns (address burnToken, address depositor, uint256 amount)
  {
    for (uint256 i = 0; i < _logs.length; i++) {
      if (_logs[i].emitter != address(TOKEN_MESSENGER) || _logs[i].topics[0] != DEPOSIT_FOR_BURN_TOPIC) {
        continue;
      }
      burnToken = address(uint160(uint256(_logs[i].topics[1])));
      depositor = address(uint160(uint256(_logs[i].topics[2])));
      amount = uint256(bytes32(_logs[i].data));
      return (burnToken, depositor, amount);
    }
    revert("DepositForBurn not emitted");
  }
}
