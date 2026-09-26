// SPDX-License-Identifier: Apache-2.0
pragma solidity >=0.8.27;
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ICurve3Pool} from "@periphery/interfaces/ICurve3Pool.sol";

contract MockCurve3Pool is ICurve3Pool {
  address[3] internal $coins;
  mapping(address tokenOut => uint256 outPerInputWad) public rate;

  uint256 public callCount;
  int128 public lastI;
  int128 public lastJ;
  uint256 public lastDx;
  uint256 public lastMinDy;

  function setCoins(address _dai, address _usdc, address _usdt) external {
    $coins = [_dai, _usdc, _usdt];
  }

  function setRate(address _tokenOut, uint256 _outPerInputWad) external {
    rate[_tokenOut] = _outPerInputWad;
  }

  function coins(uint256 _i) external view returns (address) {
    return $coins[_i];
  }

  function exchange(int128 _i, int128 _j, uint256 _dx, uint256 _minDy) external {
    callCount++;
    lastI = _i;
    lastJ = _j;
    lastDx = _dx;
    lastMinDy = _minDy;
    address tokenOut = $coins[uint256(int256(_j))];
    IERC20($coins[uint256(int256(_i))]).transferFrom(msg.sender, address(this), _dx);
    uint256 dy = (_dx * rate[tokenOut]) / 1e18;
    require(dy >= _minDy, "Exchange resulted in fewer coins than expected");
    IERC20(tokenOut).transfer(msg.sender, dy);
  }
}
