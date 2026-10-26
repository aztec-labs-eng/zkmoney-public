// SPDX-License-Identifier: Apache-2.0
pragma solidity >=0.8.27;

contract GasBurningSIPA {
  address internal immutable PORTAL;
  uint256 internal immutable FEE;
  uint256 internal immutable BURN;

  constructor(address _portal, uint256 _fee, uint256 _burn) {
    PORTAL = _portal;
    FEE = _fee;
    BURN = _burn;
  }

  function route(address) external view returns (address, uint256, uint256) {
    return (PORTAL, FEE, 0);
  }

  function sweep(address, address, bytes calldata, bytes calldata) external view {
    require(gasleft() > BURN + 5000, "not enough gas to burn");
    uint256 stop = gasleft() - BURN;
    while (gasleft() > stop) {}
  }
}
