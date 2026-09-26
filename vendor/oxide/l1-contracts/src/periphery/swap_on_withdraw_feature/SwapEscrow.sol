// SPDX-License-Identifier: Apache-2.0
pragma solidity >=0.8.27;

import {Clones} from "@openzeppelin/contracts/proxy/Clones.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IERC1271} from "@openzeppelin/contracts/interfaces/IERC1271.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {MessageHashUtils} from "@openzeppelin/contracts/utils/cryptography/MessageHashUtils.sol";
import {IUniversalRouter} from "@uniswap/universal-router/contracts/interfaces/IUniversalRouter.sol";
import {Commands} from "@uniswap/universal-router/contracts/libraries/Commands.sol";
import {ActionConstants} from "@uniswap/v4-periphery/src/libraries/ActionConstants.sol";
import {UniversalRouterLib} from "@periphery/fpc_funder/UniversalRouterLib.sol";
import {AggregatorV3Interface} from "@periphery/interfaces/AggregatorV3Interface.sol";
import {ICurve3Pool} from "@periphery/interfaces/ICurve3Pool.sol";
import {EthUsdMinOutLib} from "@periphery/EthUsdMinOutLib.sol";
import {RecoveryCommitmentLib} from "@periphery/RecoveryCommitmentLib.sol";

contract SwapEscrow {
  using SafeERC20 for IERC20;

  struct Args {
    uint8 route;
    address recipient;
    bytes32 recoveryCommitment;
    uint256 relayerTip;
    bytes32 nonce;
  }

  error SwapEscrow__NotClone();
  error SwapEscrow__NotFactory();
  error SwapEscrow__UnknownRoute(uint8 route);
  error SwapEscrow__FeedWithoutCode();
  error SwapEscrow__RecoveryCommitmentMismatch();
  error SwapEscrow__InvalidSignature();
  error SwapEscrow__NonceAlreadyUsed();
  error SwapEscrow__RecoveryExpired(uint256 deadline);
  error SwapEscrow__EmptyBalance();
  error SwapEscrow__EthTransferFailed();

  event SwapEscrowRecovered(address indexed token, address indexed target, uint256 amount);

  uint8 public constant ROUTE_USDC = 0;
  uint8 public constant ROUTE_USDT = 1;
  uint8 public constant ROUTE_ETH = 2;

  uint24 internal constant USDC_WETH_POOL_FEE = 500;

  int128 internal constant POOL3_DAI_IDX = 0;
  int128 internal constant POOL3_USDC_IDX = 1;
  int128 internal constant POOL3_USDT_IDX = 2;

  uint256 public constant BPS_DENOMINATOR = 10_000;
  uint256 public constant STABLE_MAX_SLIPPAGE_BPS = 100;
  uint256 public constant ETH_MAX_SLIPPAGE_BPS = 200;
  uint256 public constant MAX_PRICE_AGE = EthUsdMinOutLib.MAX_PRICE_AGE;
  uint256 internal constant DAI_TO_STABLE_DECIMAL_SCALE = 1e12;

  address private immutable IMPLEMENTATION = address(this);
  address public immutable FACTORY;

  IERC20 public immutable DAI;
  address public immutable USDC;
  address public immutable USDT;
  address public immutable WETH;
  IUniversalRouter public immutable UNISWAP_UNIVERSAL_ROUTER;
  ICurve3Pool public immutable THREE_POOL;
  AggregatorV3Interface public immutable ETH_USD_FEED;

  mapping(bytes32 nonce => bool used) public usedNonces;

  constructor(
    IERC20 _dai,
    address _usdc,
    address _usdt,
    address _weth,
    IUniversalRouter _router,
    ICurve3Pool _threePool,
    AggregatorV3Interface _ethUsdFeed
  ) {
    require(address(_ethUsdFeed).code.length > 0, SwapEscrow__FeedWithoutCode());
    FACTORY = msg.sender;
    DAI = _dai;
    USDC = _usdc;
    USDT = _usdt;
    WETH = _weth;
    UNISWAP_UNIVERSAL_ROUTER = _router;
    THREE_POOL = _threePool;
    ETH_USD_FEED = _ethUsdFeed;
  }

  function route() external view returns (uint8) {
    return _args().route;
  }

  function recipient() external view returns (address) {
    return _args().recipient;
  }

  function recoveryCommitment() external view returns (bytes32) {
    return _args().recoveryCommitment;
  }

  function relayerTip() external view returns (uint256) {
    return _args().relayerTip;
  }

  function nonce() external view returns (bytes32) {
    return _args().nonce;
  }

  function execute(address _tipRecipient) external {
    require(msg.sender == FACTORY, SwapEscrow__NotFactory());
    Args memory args = _args();

    uint256 amountIn = DAI.balanceOf(address(this)) - args.relayerTip;
    if (amountIn > 0) {
      _swap(args.route, args.recipient, amountIn);
    }
    DAI.safeTransfer(_tipRecipient, args.relayerTip);
  }

  function recoverERC20(
    bytes32 _recoverySalt,
    address _account,
    bytes calldata _signature,
    address _target,
    address _token,
    bytes32 _nonce,
    uint256 _deadline
  ) external {
    uint256 balance = IERC20(_token).balanceOf(address(this));
    require(balance > 0, SwapEscrow__EmptyBalance());
    bytes32 digest = keccak256(abi.encode(address(this), block.chainid, _target, _token, _nonce, _deadline));
    _authorizeRecovery(_recoverySalt, _account, _signature, digest, _nonce, _deadline);

    IERC20(_token).safeTransfer(_target, balance);
    emit SwapEscrowRecovered(_token, _target, balance);
  }

  function recoverETH(
    bytes32 _recoverySalt,
    address _account,
    bytes calldata _signature,
    address _target,
    bytes32 _nonce,
    uint256 _deadline
  ) external {
    uint256 balance = address(this).balance;
    require(balance > 0, SwapEscrow__EmptyBalance());
    bytes32 digest = keccak256(abi.encode(address(this), block.chainid, _target, _nonce, _deadline));
    _authorizeRecovery(_recoverySalt, _account, _signature, digest, _nonce, _deadline);

    (bool success,) = _target.call{value: balance}("");
    require(success, SwapEscrow__EthTransferFailed());
    emit SwapEscrowRecovered(address(0), _target, balance);
  }

  function _swap(uint8 _route, address _recipient, uint256 _amountIn) private {
    if (_route == ROUTE_USDC) {
      IERC20(USDC).safeTransfer(_recipient, _exchangeDai(POOL3_USDC_IDX, USDC, _amountIn));
    } else if (_route == ROUTE_USDT) {
      IERC20(USDT).safeTransfer(_recipient, _exchangeDai(POOL3_USDT_IDX, USDT, _amountIn));
    } else if (_route == ROUTE_ETH) {
      uint256 ethMinOut = _ethMinOut(_amountIn);
      uint256 usdcAmount = _exchangeDai(POOL3_USDC_IDX, USDC, _amountIn);
      IERC20(USDC).safeTransfer(address(UNISWAP_UNIVERSAL_ROUTER), usdcAmount);

      bytes memory commands = abi.encodePacked(uint8(Commands.V3_SWAP_EXACT_IN), uint8(Commands.UNWRAP_WETH));
      bytes[] memory inputs = new bytes[](2);
      inputs[0] = UniversalRouterLib.v3SwapExactInInput(
        ActionConstants.ADDRESS_THIS, usdcAmount, ethMinOut, abi.encodePacked(USDC, USDC_WETH_POOL_FEE, WETH)
      );
      inputs[1] = UniversalRouterLib.unwrapWethInput(_recipient, ethMinOut);
      UNISWAP_UNIVERSAL_ROUTER.execute(commands, inputs, block.timestamp);
    } else {
      revert SwapEscrow__UnknownRoute(_route);
    }
  }

  function _exchangeDai(int128 _idxOut, address _tokenOut, uint256 _amountIn) private returns (uint256) {
    DAI.forceApprove(address(THREE_POOL), _amountIn);
    THREE_POOL.exchange(POOL3_DAI_IDX, _idxOut, _amountIn, _stableMinOut(_amountIn));
    return IERC20(_tokenOut).balanceOf(address(this));
  }

  function _stableMinOut(uint256 _amountIn) private pure returns (uint256) {
    return (_amountIn * (BPS_DENOMINATOR - STABLE_MAX_SLIPPAGE_BPS)) / BPS_DENOMINATOR / DAI_TO_STABLE_DECIMAL_SCALE;
  }

  function _ethMinOut(uint256 _amountIn) private view returns (uint256) {
    return EthUsdMinOutLib.ethMinOut(ETH_USD_FEED, _amountIn, ETH_MAX_SLIPPAGE_BPS);
  }

  function _authorizeRecovery(
    bytes32 _recoverySalt,
    address _account,
    bytes calldata _signature,
    bytes32 _digest,
    bytes32 _nonce,
    uint256 _deadline
  ) private {
    require(!usedNonces[_nonce], SwapEscrow__NonceAlreadyUsed());
    require(block.timestamp <= _deadline, SwapEscrow__RecoveryExpired(_deadline));
    require(
      RecoveryCommitmentLib.deriveRecoveryCommitment(_recoverySalt, _account) == _args().recoveryCommitment,
      SwapEscrow__RecoveryCommitmentMismatch()
    );
    require(_isValidSignature(_account, _digest, _signature), SwapEscrow__InvalidSignature());

    usedNonces[_nonce] = true;
  }

  function _isValidSignature(address _account, bytes32 _digest, bytes calldata _signature) private view returns (bool) {
    if (_account.code.length == 0) {
      (address recovered, ECDSA.RecoverError err,) =
        ECDSA.tryRecoverCalldata(MessageHashUtils.toEthSignedMessageHash(_digest), _signature);
      return err == ECDSA.RecoverError.NoError && recovered == _account;
    }
    return IERC1271(_account).isValidSignature(_digest, _signature) == IERC1271.isValidSignature.selector;
  }

  function _args() private view returns (Args memory) {
    require(address(this) != IMPLEMENTATION, SwapEscrow__NotClone());
    return abi.decode(Clones.fetchCloneArgs(address(this)), (Args));
  }
}
