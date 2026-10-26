// SPDX-License-Identifier: Apache-2.0
pragma solidity >=0.8.27;

import {IERC20} from "@oz/token/ERC20/IERC20.sol";

contract MockCallTarget {
  struct Record {
    uint256 id;
    address caller;
    uint256 balance;
  }

  Record[] internal $records;

  function revertWith(bytes calldata _data) external pure {
    bytes memory data = _data;
    assembly {
      revert(add(data, 0x20), mload(data))
    }
  }

  function recordCount() external view returns (uint256) {
    return $records.length;
  }

  function recordAt(uint256 _i) external view returns (Record memory) {
    return $records[_i];
  }

  function record(uint256 _id, IERC20 _token) external {
    $records.push(Record({id: _id, caller: msg.sender, balance: _token.balanceOf(address(this))}));
  }
}
