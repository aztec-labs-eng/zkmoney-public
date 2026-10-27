// SPDX-License-Identifier: Apache-2.0
pragma solidity >=0.8.27;

import {IOxidePortal} from "@core/interfaces/IOxidePortal.sol";

interface ISIPA {
  function sweep(address token, address relayer, bytes calldata intentData, bytes calldata proofs) external;

  function route(address token) external view returns (IOxidePortal portal, uint256 sweepTip, uint256 beneficiaryFee);
}
