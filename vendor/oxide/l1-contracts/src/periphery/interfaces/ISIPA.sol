// SPDX-License-Identifier: Apache-2.0
pragma solidity >=0.8.27;

import {IOxidePortal} from "@core/interfaces/IOxidePortal.sol";

interface ISIPA {
  function sweep(address token, address relayer, bytes calldata intentData, bytes calldata proofs) external;

  function portal() external view returns (IOxidePortal);

  function depositFee() external view returns (uint256);
}
