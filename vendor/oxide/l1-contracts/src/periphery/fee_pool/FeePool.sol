// SPDX-License-Identifier: Apache-2.0
pragma solidity >=0.8.27;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Address} from "@openzeppelin/contracts/utils/Address.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {IWETH9} from "@uniswap/v4-periphery/src/interfaces/external/IWETH9.sol";
import {IFeePool} from "@periphery/interfaces/IFeePool.sol";
import {Errors} from "@periphery/Errors.sol";

// solhint-disable-next-line oxide/no-comments
/**
 * @notice Holds protocol fees as ETH and WETH, and pays them as ETH to spenders.
 * Each spender has a rate cap, an expiry, and a reserve that spenders appended later cannot take.
 */
contract FeePool is IFeePool, Ownable {
  IWETH9 public immutable WETH;

  address[] internal $spenderList;

  mapping(address spender => Spender) internal $spenders;

  constructor(address _owner, IWETH9 _weth) Ownable(_owner) {
    require(address(_weth).code.length > 0, Errors.FeePool__WethWithoutCode());
    WETH = _weth;
  }

  receive() external payable {}

  function append(SpenderConfig calldata _config, uint64 _idleDelay) external override onlyOwner {
    require(_config.spender != address(0), Errors.FeePool__ZeroSpender());
    require(_config.activeUntil > block.timestamp, Errors.FeePool__ActiveUntilNotInFuture(_config.activeUntil));
    require(_config.period > 0, Errors.FeePool__ZeroPeriod());
    require(
      _config.amountPerPeriod >= _config.period,
      Errors.FeePool__RefillBelowOneWeiPerSecond(_config.amountPerPeriod, _config.period)
    );
    require(_config.idleTimeout > 0, Errors.FeePool__ZeroIdleTimeout());
    uint64 idleFrom = uint64(block.timestamp) + _idleDelay;
    require(idleFrom < _config.activeUntil, Errors.FeePool__IdleFromNotBeforeActiveUntil(idleFrom, _config.activeUntil));
    uint256 totalReserves = _cleanUp(address(0));
    require(!_isListed($spenders[_config.spender]), Errors.FeePool__SpenderAlreadyListed(_config.spender));

    $spenders[_config.spender] = Spender({
      config: _config, rateCapLeft: _config.amountPerPeriod, lastPulledAt: idleFrom, protectedReserves: totalReserves
    });
    $spenderList.push(_config.spender);
    emit Appended(_config.spender, _config, idleFrom);
  }

  // solhint-disable-next-line oxide/no-comments
  /// @notice Pass `type(uint256).max` to pull all that the spender can pull now.
  function pull(uint256 _amount) external override returns (uint256 amount) {
    Spender storage spender = $spenders[msg.sender];
    require(_isLive(spender), Errors.FeePool__NotALiveSpender(msg.sender));
    (uint256 rateCapLeft, uint256 pullable) = _pullLimits(spender);

    amount = _amount == type(uint256).max ? pullable : _amount;
    require(amount <= pullable, Errors.FeePool__AmountAboveAvailable(amount, pullable));

    spender.rateCapLeft = uint192(rateCapLeft - amount);
    spender.lastPulledAt = uint64(block.timestamp);
    if (amount == 0) {
      return 0;
    }
    emit Pulled(msg.sender, amount);

    uint256 ethBalance = address(this).balance;
    if (ethBalance < amount) {
      WETH.withdraw(amount - ethBalance);
    }
    Address.sendValue(payable(msg.sender), amount);
  }

  // solhint-disable-next-line oxide/no-comments
  /// @notice The spender calls this to remove itself from the pool.
  function renounce() external payable override {
    if (!_isListed($spenders[msg.sender])) {
      // solhint-disable-next-line oxide/no-comments
      // Another call can remove a spender before it renounces. Do nothing instead of a revert.
      return;
    }
    _cleanUp(msg.sender);
    emit Renounced(msg.sender);
  }

  // solhint-disable-next-line oxide/no-comments
  /**
   * @notice Anybody can call this to remove a spender that is past its `activeUntil`, or that did not pull for longer
   * than its `idleTimeout`.
   */
  function release(address _spender) external override {
    Spender storage spender = $spenders[_spender];
    require(_isListed(spender), Errors.FeePool__SpenderNotListed(_spender));
    require(!_isLive(spender) || _isIdle(spender), Errors.FeePool__SpenderNotReleasable(_spender));
    _cleanUp(_spender);
    emit Released(_spender);
  }

  function available(address _spender) external view override returns (uint256) {
    Spender storage spender = $spenders[_spender];
    if (!_isLive(spender)) {
      return 0;
    }
    (, uint256 pullable) = _pullLimits(spender);
    return pullable;
  }

  function spenders() external view override returns (Spender[] memory list) {
    list = new Spender[]($spenderList.length);
    for (uint256 i = 0; i < list.length; i++) {
      list[i] = $spenders[$spenderList[i]];
    }
  }

  function balance() public view override returns (uint256) {
    return address(this).balance + WETH.balanceOf(address(this));
  }

  function _isListed(Spender storage _spender) internal view returns (bool) {
    return _spender.config.spender != address(0);
  }

  function _isLive(Spender storage _spender) internal view returns (bool) {
    return block.timestamp <= _spender.config.activeUntil;
  }

  function _isIdle(Spender storage _spender) internal view returns (bool) {
    return block.timestamp > uint256(_spender.lastPulledAt) + _spender.config.idleTimeout;
  }

  function _pullLimits(Spender storage _spender) internal view returns (uint256 rateCapLeft, uint256 pullable) {
    uint256 lastPulledAt = _spender.lastPulledAt;
    uint256 elapsed = block.timestamp > lastPulledAt ? block.timestamp - lastPulledAt : 0;
    uint256 amountPerPeriod = _spender.config.amountPerPeriod;
    uint256 refill = Math.mulDiv(elapsed, amountPerPeriod, _spender.config.period);
    rateCapLeft = Math.min(amountPerPeriod, _spender.rateCapLeft + refill);

    uint256 protectedReserves = _spender.protectedReserves;
    uint256 poolBalance = balance();
    uint256 unprotectedBalance = poolBalance > protectedReserves ? poolBalance - protectedReserves : 0;
    pullable = Math.min(rateCapLeft, unprotectedBalance);
  }

  // solhint-disable-next-line oxide/no-comments
  /**
   * @dev Removes `_drop` and every expired spender, and updates the `protectedReserves` of the spenders that are left.
   * @param _drop The spender to remove, or `address(0)` to remove only the expired spenders.
   * @return totalReserves The sum of the reserves of the spenders that are left.
   */
  function _cleanUp(address _drop) internal returns (uint256 totalReserves) {
    uint256 newIndex = 0;
    uint256 length = $spenderList.length;
    for (uint256 i = 0; i < length; i++) {
      address item = $spenderList[i];
      Spender storage spender = $spenders[item];
      if (item == _drop || !_isLive(spender)) {
        delete $spenders[item];
        if (item != _drop) {
          emit Released(item);
        }
        continue;
      }
      spender.protectedReserves = totalReserves;
      totalReserves += spender.config.reserve;
      $spenderList[newIndex] = item;
      newIndex++;
    }
    // solhint-disable-next-line oxide/no-comments
    // The kept spenders moved down, so the slots from `newIndex` to the end hold old copies. Remove them.
    for (uint256 i = newIndex; i < length; i++) {
      $spenderList.pop();
    }
  }
}
