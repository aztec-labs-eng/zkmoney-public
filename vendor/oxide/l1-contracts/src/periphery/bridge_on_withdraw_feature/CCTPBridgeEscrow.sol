// SPDX-License-Identifier: Apache-2.0
pragma solidity >=0.8.27;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ICurve3Pool} from "@periphery/interfaces/ICurve3Pool.sol";
import {ITokenMessengerV2} from "@periphery/interfaces/ITokenMessengerV2.sol";
import {EscrowBase} from "@periphery/EscrowBase.sol";
import {ThreePoolLib, POOL3_USDC_IDX} from "@periphery/ThreePoolLib.sol";

contract CCTPBridgeEscrow is EscrowBase {
  using SafeERC20 for IERC20;

  // solhint-disable oxide/no-comments
  struct Args {
    // ROUTE_DIRECT mints to `recipient`. ROUTE_HYPERCORE_SPOT mints to the CctpForwarder, which credits `recipient` on
    // HyperCore spot.
    uint8 route;
    // CCTP domain, for example 6 Base, 7 Polygon, 19 HyperEVM.
    uint32 destinationDomain;
    address recipient;
    // 1000 Fast Transfer, 2000 Standard Transfer.
    uint32 minFinalityThreshold;
    // USDC that Circle takes in full, including the forwarding and HyperCore deposit fees.
    uint256 maxFee;
    bytes32 recoveryCommitment;
    // DAI paid to the relayer that executes the escrow.
    uint256 relayerTip;
    bytes32 nonce;
  }
  // solhint-enable oxide/no-comments

  error CCTPBridgeEscrow__UnknownRoute(uint8 route);
  error CCTPBridgeEscrow__NotHyperEvmDomain(uint32 destinationDomain);
  error CCTPBridgeEscrow__ZeroRecipient();
  error CCTPBridgeEscrow__AmountNotAboveMaxFee(uint256 amount, uint256 maxFee);

  uint8 public constant ROUTE_DIRECT = 0;
  uint8 public constant ROUTE_HYPERCORE_SPOT = 1;

  uint32 public constant HYPEREVM_DOMAIN = 19;
  uint32 internal constant HYPERCORE_SPOT_DEX = type(uint32).max;
  uint32 internal constant FORWARD_HOOK_VERSION = 0;
  uint32 internal constant DIRECT_FORWARD_DATA_LENGTH = 0;
  uint32 internal constant HYPERCORE_FORWARD_DATA_LENGTH = 24;
  bytes24 internal constant FORWARD_MAGIC = bytes24("cctp-forward");

  IERC20 public immutable DAI;
  address public immutable USDC;
  ICurve3Pool public immutable THREE_POOL;
  ITokenMessengerV2 public immutable TOKEN_MESSENGER;
  address public immutable HYPEREVM_CCTP_FORWARDER;

  constructor(
    IERC20 _dai,
    address _usdc,
    ICurve3Pool _threePool,
    ITokenMessengerV2 _tokenMessenger,
    address _hyperEvmCctpForwarder
  ) {
    DAI = _dai;
    USDC = _usdc;
    THREE_POOL = _threePool;
    TOKEN_MESSENGER = _tokenMessenger;
    HYPEREVM_CCTP_FORWARDER = _hyperEvmCctpForwarder;
  }

  function route() external view returns (uint8) {
    return _args().route;
  }

  function destinationDomain() external view returns (uint32) {
    return _args().destinationDomain;
  }

  function recipient() external view returns (address) {
    return _args().recipient;
  }

  function minFinalityThreshold() external view returns (uint32) {
    return _args().minFinalityThreshold;
  }

  function maxFee() external view returns (uint256) {
    return _args().maxFee;
  }

  function relayerTip() external view returns (uint256) {
    return _args().relayerTip;
  }

  function nonce() external view returns (bytes32) {
    return _args().nonce;
  }

  function execute(address _tipRecipient) external override onlyFactory {
    Args memory args = _args();
    (bytes32 mintRecipient, bytes32 destinationCaller, bytes memory hookData) = _burnTarget(args);

    uint256 amountIn = DAI.balanceOf(address(this)) - args.relayerTip;
    uint256 usdcAmount = ThreePoolLib.swapDaiTo(
      THREE_POOL, address(DAI), POOL3_USDC_IDX, USDC, amountIn, ThreePoolLib.SWAP_MAX_SLIPPAGE_BPS
    );
    require(usdcAmount > args.maxFee, CCTPBridgeEscrow__AmountNotAboveMaxFee(usdcAmount, args.maxFee));

    IERC20(USDC).forceApprove(address(TOKEN_MESSENGER), usdcAmount);
    TOKEN_MESSENGER.depositForBurnWithHook(
      usdcAmount,
      args.destinationDomain,
      mintRecipient,
      USDC,
      destinationCaller,
      args.maxFee,
      args.minFinalityThreshold,
      hookData
    );
    DAI.safeTransfer(_tipRecipient, args.relayerTip);
  }

  function _recoveryCommitment() internal view override returns (bytes32) {
    return _args().recoveryCommitment;
  }

  function _burnTarget(Args memory _escrowArgs)
    private
    view
    returns (bytes32 mintRecipient, bytes32 destinationCaller, bytes memory hookData)
  {
    if (_escrowArgs.route == ROUTE_DIRECT) {
      return (
        _toBytes32(_escrowArgs.recipient),
        bytes32(0),
        abi.encodePacked(FORWARD_MAGIC, FORWARD_HOOK_VERSION, DIRECT_FORWARD_DATA_LENGTH)
      );
    }
    if (_escrowArgs.route == ROUTE_HYPERCORE_SPOT) {
      require(
        _escrowArgs.destinationDomain == HYPEREVM_DOMAIN,
        CCTPBridgeEscrow__NotHyperEvmDomain(_escrowArgs.destinationDomain)
      );
      require(_escrowArgs.recipient != address(0), CCTPBridgeEscrow__ZeroRecipient());
      bytes32 forwarder = _toBytes32(HYPEREVM_CCTP_FORWARDER);
      return (
        forwarder,
        forwarder,
        abi.encodePacked(
          FORWARD_MAGIC, FORWARD_HOOK_VERSION, HYPERCORE_FORWARD_DATA_LENGTH, _escrowArgs.recipient, HYPERCORE_SPOT_DEX
        )
      );
    }
    revert CCTPBridgeEscrow__UnknownRoute(_escrowArgs.route);
  }

  function _args() private view returns (Args memory) {
    return abi.decode(_cloneArgs(), (Args));
  }

  function _toBytes32(address _address) private pure returns (bytes32) {
    return bytes32(uint256(uint160(_address)));
  }
}
