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

  function portal() external view returns (address) {
    return PORTAL;
  }

  function depositFee() external view returns (uint256) {
    return FEE;
  }

  function sweep(address, address, bytes calldata, bytes calldata) external view {
    require(gasleft() > BURN + 5000, "not enough gas to burn");
    uint256 stop = gasleft() - BURN;
    while (gasleft() > stop) {}
  }
}
