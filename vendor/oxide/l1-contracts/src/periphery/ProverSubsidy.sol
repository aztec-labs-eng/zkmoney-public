// SPDX-License-Identifier: Apache-2.0
// Copyright 2025 Aztec Labs.
pragma solidity >=0.8.27;

import {Ownable} from "@oz/access/Ownable.sol";
import {IERC20} from "@oz/token/ERC20/IERC20.sol";
import {Math} from "@oz/utils/math/Math.sol";
import {SafeERC20} from "@oz/token/ERC20/utils/SafeERC20.sol";
import {IProverSubsidy} from "@core/interfaces/IProverSubsidy.sol";
import {IOxidePortal} from "@core/interfaces/IOxidePortal.sol";
import {Errors} from "@periphery/Errors.sol";

contract ProverSubsidy is IProverSubsidy, Ownable {
  using SafeERC20 for IERC20;

  address public immutable PORTAL;
  IERC20 public immutable TOKEN;

  uint256 public $subsidyPerProverClaim;

  constructor(address _owner, address _portal) Ownable(_owner) {
    PORTAL = _portal;
    TOKEN = IOxidePortal(_portal).UNDERLYING();
  }

  function setSubsidy(uint256 _subsidyPerProverClaim) external onlyOwner {
    $subsidyPerProverClaim = _subsidyPerProverClaim;
  }

  function paySubsidy(uint256 _numClaims, address _to) external override returns (uint256 subsidy) {
    require(msg.sender == PORTAL, Errors.ProverSubsidy__UnauthorizedPortal());

    subsidy = quoteSubsidy(_numClaims);
    if (subsidy > 0) {
      TOKEN.safeTransfer(_to, subsidy);
    }
  }

  function quoteSubsidy(uint256 _numClaims) public view override returns (uint256) {
    uint256 quoted = _numClaims * $subsidyPerProverClaim;
    return Math.min(TOKEN.balanceOf(address(this)), quoted);
  }

  function defund() external onlyOwner {
    TOKEN.safeTransfer(owner(), TOKEN.balanceOf(address(this)));
  }
}
