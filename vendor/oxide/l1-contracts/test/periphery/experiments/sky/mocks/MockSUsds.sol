// SPDX-License-Identifier: Apache-2.0
pragma solidity >=0.8.27;

import {ERC20} from "@oz/token/ERC20/ERC20.sol";
import {Ownable} from "@oz/access/Ownable.sol";
import {TestERC20} from "@aztec/mock/TestERC20.sol";

contract MockSUsds is ERC20, Ownable {
  uint256 internal constant WAD = 1e18;

  TestERC20 public immutable USDS;

  uint256 public pricePerShare = WAD;

  bool public broken;

  event Referral(uint16 indexed referral, address indexed owner, uint256 assets, uint256 shares);

  error MockSUsds__Paused();

  constructor(TestERC20 _usds, address _owner) ERC20("Savings USDS", "sUSDS") Ownable(_owner) {
    USDS = _usds;
  }

  function setPricePerShare(uint256 _pricePerShare) external onlyOwner {
    pricePerShare = _pricePerShare;
  }

  function setBroken(bool _broken) external onlyOwner {
    broken = _broken;
  }

  function asset() external view returns (address) {
    return address(USDS);
  }

  function convertToShares(uint256 _assets) public view returns (uint256) {
    return (_assets * WAD) / pricePerShare;
  }

  function convertToAssets(uint256 _shares) public view returns (uint256) {
    return (_shares * pricePerShare) / WAD;
  }

  function deposit(uint256 _assets, address _receiver) public returns (uint256 shares) {
    require(!broken, MockSUsds__Paused());
    shares = convertToShares(_assets);
    USDS.transferFrom(msg.sender, address(this), _assets);
    _mint(_receiver, shares);
  }

  function deposit(uint256 _assets, address _receiver, uint16 _referral) external returns (uint256 shares) {
    shares = deposit(_assets, _receiver);
    emit Referral(_referral, _receiver, _assets, shares);
  }

  function redeem(uint256 _shares, address _receiver, address _owner) external returns (uint256 assets) {
    require(!broken, MockSUsds__Paused());
    assets = convertToAssets(_shares);
    if (_owner != msg.sender) {
      _spendAllowance(_owner, msg.sender, _shares);
    }
    _burn(_owner, _shares);
    uint256 held = USDS.balanceOf(address(this));
    if (held < assets) {
      USDS.mint(address(this), assets - held);
    }
    USDS.transfer(_receiver, assets);
  }
}
