// SPDX-License-Identifier: Apache-2.0
pragma solidity >=0.8.27;
import {Test} from "forge-std/Test.sol";

import {TestERC20} from "@aztec/mock/TestERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IUniversalRouter} from "@uniswap/universal-router/contracts/interfaces/IUniversalRouter.sol";

import {AggregatorV3Interface} from "@periphery/interfaces/AggregatorV3Interface.sol";
import {ICurve3Pool} from "@periphery/interfaces/ICurve3Pool.sol";
import {OxideAccount} from "@periphery/OxideAccount.sol";
import {OxideAccountFactory} from "@periphery/OxideAccountFactory.sol";
import {RecoveryCommitmentLib} from "@periphery/RecoveryCommitmentLib.sol";
import {SwapEscrow} from "@periphery/swap_on_withdraw_feature/SwapEscrow.sol";
import {SwapEscrowFactory} from "@periphery/swap_on_withdraw_feature/SwapEscrowFactory.sol";
import {AccountSignatures} from "@test/helpers/AccountSignatures.sol";
import {MockCurve3Pool} from "@test/mocks/MockCurve3Pool.sol";
import {MockV3Aggregator} from "@test/mocks/MockV3Aggregator.sol";
import {MockUniversalRouter} from "./MockUniversalRouter.sol";

abstract contract SwapEscrowTestBase is Test {
  uint256 internal constant AMOUNT = 2500e18;
  uint256 internal constant TIP = 25e18;
  bytes32 internal constant NONCE = keccak256("nonce");
  bytes32 internal constant RECOVERY_SALT = keccak256("recovery-salt");
  uint256 internal constant PASSKEY_INDEX = 0;

  uint256 internal constant USDC_RATE = 99e16;
  uint256 internal constant USDT_RATE = 98e16;
  uint256 internal constant WETH_RATE = 4e14;

  uint8 internal constant FEED_DECIMALS = 8;
  int256 internal constant ETH_USD_ANSWER = 2500e8;

  TestERC20 internal dai;
  TestERC20 internal usdc;
  TestERC20 internal usdt;
  address internal weth = makeAddr("weth");
  MockCurve3Pool internal threePool;
  MockUniversalRouter internal router;
  MockV3Aggregator internal ethUsdFeed;
  SwapEscrowFactory internal factory;
  SwapEscrow internal implementation;

  address internal relayer = makeAddr("relayer");
  address internal alice = makeAddr("alice");
  OxideAccountFactory internal accountFactory;
  OxideAccount internal account;
  uint256 internal passkey;

  function setUp() public virtual {
    accountFactory = new OxideAccountFactory();
    account = OxideAccount(payable(accountFactory.deploy(makeAddr("bootstrap"))));
    passkey = _p256Key("passkey");
    (uint256 qx, uint256 qy) = vm.publicKeyP256(passkey);
    vm.prank(address(account.entryPoint()));
    account.addAuthKey(OxideAccount.R1Key({qx: bytes32(qx), qy: bytes32(qy)}), "passkey:recovery");

    dai = new TestERC20("DAI", "DAI", address(this));
    usdc = new TestERC20("USDC", "USDC", address(this));
    usdt = new TestERC20("USDT", "USDT", address(this));

    threePool = new MockCurve3Pool();
    threePool.setCoins(address(dai), address(usdc), address(usdt));
    threePool.setRate(address(usdc), USDC_RATE);
    threePool.setRate(address(usdt), USDT_RATE);
    usdc.mint(address(threePool), 1_000_000e18);
    usdt.mint(address(threePool), 1_000_000e18);

    router = new MockUniversalRouter();
    router.setRate(weth, WETH_RATE);
    vm.deal(address(router), 1000 ether);

    ethUsdFeed = new MockV3Aggregator(FEED_DECIMALS, ETH_USD_ANSWER);

    factory = new SwapEscrowFactory(
      IERC20(address(dai)),
      address(usdc),
      address(usdt),
      weth,
      IUniversalRouter(address(router)),
      ICurve3Pool(address(threePool)),
      AggregatorV3Interface(address(ethUsdFeed))
    );
    implementation = SwapEscrow(factory.IMPLEMENTATION());
  }

  function _ethOut(uint256 _daiIn) internal pure returns (uint256) {
    return (((_daiIn * USDC_RATE) / 1e18) * WETH_RATE) / 1e18;
  }

  function _args(uint8 _route) internal view returns (SwapEscrow.Args memory) {
    return SwapEscrow.Args({
      route: _route,
      recipient: alice,
      recoveryCommitment: RecoveryCommitmentLib.deriveRecoveryCommitment(RECOVERY_SALT, address(account)),
      relayerTip: TIP,
      nonce: NONCE
    });
  }

  function _signRecoverERC20(address _escrow, address _target, address _token, bytes32 _nonce, uint256 _deadline)
    internal
    view
    returns (bytes memory)
  {
    return _sign(passkey, keccak256(abi.encode(_escrow, block.chainid, _target, _token, _nonce, _deadline)));
  }

  function _signRecoverETH(address _escrow, address _target, bytes32 _nonce, uint256 _deadline)
    internal
    view
    returns (bytes memory)
  {
    return _sign(passkey, keccak256(abi.encode(_escrow, block.chainid, _target, _nonce, _deadline)));
  }

  function _sign(uint256 _passkey, bytes32 _digest) internal view returns (bytes memory) {
    return
      AccountSignatures.r1(PASSKEY_INDEX, _passkey, AccountSignatures.personalSignDigest(address(account), _digest));
  }

  function _p256Key(string memory _name) internal pure returns (uint256) {
    return uint256(keccak256(bytes(_name))) % AccountSignatures.P256_N;
  }

  function _fundAndDeploy(SwapEscrow.Args memory _escrowArgs, uint256 _funding) internal returns (address escrow) {
    dai.mint(factory.predictEscrowAddress(_escrowArgs), _funding);
    vm.prank(relayer);
    escrow = factory.deployAndExecute(_escrowArgs);
  }
}
