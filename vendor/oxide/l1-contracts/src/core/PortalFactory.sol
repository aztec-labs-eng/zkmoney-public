// SPDX-License-Identifier: Apache-2.0
pragma solidity >=0.8.28;
import {IVerifier} from "@aztec/core/interfaces/IVerifier.sol";
import {IRegistry} from "@aztec/governance/interfaces/IRegistry.sol";
import {Ownable} from "@oz/access/Ownable.sol";
import {IERC20} from "@oz/token/ERC20/IERC20.sol";
import {Create2} from "@oz/utils/Create2.sol";
import {OxidePortal} from "./OxidePortal.sol";
import {IPortalFactory} from "./interfaces/IPortalFactory.sol";
import {ITeeRegistry} from "@core/interfaces/ITeeRegistry.sol";
import {Errors} from "@core/lib/Errors.sol";

contract PortalFactory is Ownable, IPortalFactory {
  struct PortalCaps {
    uint128 txAmountCap;
    uint256 rate;
    uint256 globalLimit;
  }

  ITeeRegistry public immutable TEE_REGISTRY;
  IRegistry public immutable REGISTRY;
  uint256 public immutable ROLLUP_VERSION;
  IVerifier public immutable FROZEN_NOTES_REFUND_VERIFIER;
  IVerifier public immutable FROZEN_DEPOSITS_REFUND_VERIFIER;
  IVerifier public immutable UNPROCESSED_DEPOSIT_REFUND_VERIFIER;

  bytes32 public constant PORTAL_SALT = bytes32(0);

  // solhint-disable-next-line oxide/no-comments
  /**
   * @dev The portal's constructor reads its L2 token from here. A constructor argument would change the portal's
   * address, which the L2 token's address commits to.
   */
  bytes32 internal transient $pendingL2Token;

  event PortalDeployed(address indexed portal, IERC20 indexed underlying, bytes32 l2Token, PortalCaps caps);

  constructor(
    address _owner,
    ITeeRegistry _teeRegistry,
    IRegistry _registry,
    uint256 _rollupVersion,
    OxidePortal.RefundVerifiers memory _verifiers
  ) Ownable(_owner) {
    require(_teeRegistry.ROLLUP_VERSION() == _rollupVersion, Errors.PortalFactory__RollupVersionMismatch());
    TEE_REGISTRY = _teeRegistry;
    REGISTRY = _registry;
    ROLLUP_VERSION = _rollupVersion;
    FROZEN_NOTES_REFUND_VERIFIER = _verifiers.frozenNotes;
    FROZEN_DEPOSITS_REFUND_VERIFIER = _verifiers.frozenDeposits;
    UNPROCESSED_DEPOSIT_REFUND_VERIFIER = _verifiers.unprocessedDeposit;
  }

  function pendingL2Token() external view override(IPortalFactory) returns (bytes32) {
    return $pendingL2Token;
  }

  function deployPortal(IERC20 _underlying, bytes32 _l2Token, PortalCaps calldata _caps)
    external
    onlyOwner
    returns (OxidePortal portal)
  {
    require(_l2Token != bytes32(0), Errors.PortalFactory__ZeroL2Token());
    $pendingL2Token = _l2Token;
    portal = OxidePortal(Create2.deploy(0, PORTAL_SALT, _initCode(_underlying, _caps)));
    $pendingL2Token = bytes32(0);
    emit PortalDeployed(address(portal), _underlying, _l2Token, _caps);
  }

  function predictPortalAddress(IERC20 _underlying, PortalCaps calldata _caps) external view returns (address) {
    return Create2.computeAddress(PORTAL_SALT, keccak256(_initCode(_underlying, _caps)));
  }

  function _initCode(IERC20 _underlying, PortalCaps calldata _caps) internal view returns (bytes memory) {
    return abi.encodePacked(
      type(OxidePortal).creationCode,
      abi.encode(
        TEE_REGISTRY,
        _underlying,
        REGISTRY,
        ROLLUP_VERSION,
        OxidePortal.RefundVerifiers({
          frozenNotes: FROZEN_NOTES_REFUND_VERIFIER,
          frozenDeposits: FROZEN_DEPOSITS_REFUND_VERIFIER,
          unprocessedDeposit: UNPROCESSED_DEPOSIT_REFUND_VERIFIER
        }),
        _caps.txAmountCap,
        _caps.rate,
        _caps.globalLimit
      )
    );
  }
}
