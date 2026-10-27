// SPDX-License-Identifier: Apache-2.0
pragma solidity >=0.8.27;

import {Test, Vm} from "forge-std/Test.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {IWETH9} from "@uniswap/v4-periphery/src/interfaces/external/IWETH9.sol";
import {FeePool} from "@periphery/fee_pool/FeePool.sol";
import {IFeePool} from "@periphery/interfaces/IFeePool.sol";
import {Errors} from "@periphery/Errors.sol";
import {MockWETH9} from "@test/mocks/MockWETH9.sol";

contract ReentrantSpender {
  FeePool internal immutable POOL;
  uint256 public nestedAmount;
  bool internal reentered;

  constructor(FeePool _pool) {
    POOL = _pool;
  }

  function pull(uint256 _amount) external returns (uint256) {
    return POOL.pull(_amount);
  }

  receive() external payable {
    if (reentered) {
      return;
    }
    reentered = true;
    nestedAmount = POOL.pull(type(uint256).max);
  }
}

contract FeePoolTest is Test {
  uint192 internal constant NO_CAP = type(uint192).max;
  uint64 internal constant NO_EXPIRY = type(uint64).max;
  uint64 internal constant PERIOD = 7 days;
  uint64 internal constant IDLE_TIMEOUT = 90 days;
  uint64 internal constant ACTIVE_FOR = 30 days;
  uint64 internal constant IDLE_DELAY = 10 days;

  address internal owner = makeAddr("owner");
  address internal fpcFunder = makeAddr("fpcFunder");
  address internal subsidyManager = makeAddr("subsidyManager");
  address internal nextSpender = makeAddr("nextSpender");

  MockWETH9 internal weth;
  FeePool internal pool;

  function setUp() public {
    weth = new MockWETH9();
    pool = new FeePool(owner, IWETH9(address(weth)));
  }

  function test_constructorStoresWethAndOwner() public view {
    assertEq(address(pool.WETH()), address(weth));
    assertEq(pool.owner(), owner);
  }

  function test_constructorRejectsWethWithoutCode() public {
    vm.expectRevert(Errors.FeePool__WethWithoutCode.selector);
    new FeePool(owner, IWETH9(makeAddr("noCode")));
  }

  function test_constructorRejectsZeroOwner() public {
    vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableInvalidOwner.selector, address(0)));
    new FeePool(address(0), IWETH9(address(weth)));
  }

  function test_onlyTheOwnerAppends() public {
    vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, address(this)));
    pool.append(_config(fpcFunder, 0, NO_CAP, NO_EXPIRY), 0);
  }

  function test_appendStoresTheSpender() public {
    IFeePool.SpenderConfig memory config = _config(fpcFunder, 10 ether, 4 ether, uint64(block.timestamp + ACTIVE_FOR));

    vm.expectEmit();
    emit IFeePool.Appended(fpcFunder, config, uint64(block.timestamp));
    vm.prank(owner);
    pool.append(config, 0);

    IFeePool.Spender[] memory spenders = pool.spenders();
    assertEq(spenders.length, 1);
    IFeePool.Spender memory spender = spenders[0];
    assertEq(spender.config.spender, fpcFunder);
    assertEq(spender.config.reserve, 10 ether);
    assertEq(spender.config.amountPerPeriod, 4 ether);
    assertEq(spender.config.period, PERIOD);
    assertEq(spender.config.idleTimeout, IDLE_TIMEOUT);
    assertEq(spender.config.activeUntil, block.timestamp + ACTIVE_FOR);
    assertEq(spender.protectedReserves, 0);
    assertEq(spender.lastPulledAt, block.timestamp);
    assertEq(spender.rateCapLeft, 4 ether, "the rate cap starts full");
  }

  function test_appendRejectsAZeroSpender() public {
    _expectAppendRevert(
      _config(address(0), 0, NO_CAP, NO_EXPIRY), abi.encodeWithSelector(Errors.FeePool__ZeroSpender.selector)
    );
  }

  function test_appendRejectsAnActiveUntilNotInTheFuture() public {
    _expectAppendRevert(
      _config(fpcFunder, 0, NO_CAP, uint64(block.timestamp)),
      abi.encodeWithSelector(Errors.FeePool__ActiveUntilNotInFuture.selector, uint64(block.timestamp))
    );
  }

  function test_appendRejectsAZeroPeriod() public {
    IFeePool.SpenderConfig memory config = _config(fpcFunder, 0, NO_CAP, NO_EXPIRY);
    config.period = 0;
    _expectAppendRevert(config, abi.encodeWithSelector(Errors.FeePool__ZeroPeriod.selector));
  }

  function test_appendRejectsARefillBelowOneWeiPerSecond() public {
    _expectAppendRevert(
      _config(fpcFunder, 0, uint192(PERIOD) - 1, NO_EXPIRY),
      abi.encodeWithSelector(Errors.FeePool__RefillBelowOneWeiPerSecond.selector, uint192(PERIOD) - 1, PERIOD)
    );
    _expectAppendRevert(
      _config(fpcFunder, 0, 0, NO_EXPIRY),
      abi.encodeWithSelector(Errors.FeePool__RefillBelowOneWeiPerSecond.selector, 0, PERIOD)
    );
  }

  function test_appendRejectsAZeroIdleTimeout() public {
    IFeePool.SpenderConfig memory config = _config(fpcFunder, 0, NO_CAP, NO_EXPIRY);
    config.idleTimeout = 0;
    _expectAppendRevert(config, abi.encodeWithSelector(Errors.FeePool__ZeroIdleTimeout.selector));
  }

  function test_appendDelaysTheIdleTimer() public {
    IFeePool.SpenderConfig memory config = _config(fpcFunder, 0, 4 ether, NO_EXPIRY);
    uint64 idleFrom = uint64(block.timestamp + IDLE_DELAY);

    vm.expectEmit();
    emit IFeePool.Appended(fpcFunder, config, idleFrom);
    vm.prank(owner);
    pool.append(config, IDLE_DELAY);

    assertEq(_spender(0).lastPulledAt, idleFrom);
    assertEq(_spender(0).rateCapLeft, 4 ether, "the rate cap starts full");
  }

  function test_appendRejectsAnIdleDelayThatEndsAtActiveUntil() public {
    uint64 activeUntil = uint64(block.timestamp + ACTIVE_FOR);
    _expectAppendRevert(
      _config(fpcFunder, 0, NO_CAP, activeUntil),
      ACTIVE_FOR,
      abi.encodeWithSelector(Errors.FeePool__IdleFromNotBeforeActiveUntil.selector, activeUntil, activeUntil)
    );
  }

  function test_appendRejectsAListedSpender() public {
    _append(fpcFunder, 10 ether, NO_CAP);
    _expectAppendRevert(
      _config(fpcFunder, 20 ether, NO_CAP, NO_EXPIRY),
      abi.encodeWithSelector(Errors.FeePool__SpenderAlreadyListed.selector, fpcFunder)
    );
  }

  function test_availableLeavesTheProtectedReserves() public {
    _append(fpcFunder, 10 ether, NO_CAP);
    _append(subsidyManager, 15 ether, NO_CAP);

    _fundWeth(50 ether);
    assertEq(pool.available(fpcFunder), 50 ether);
    assertEq(pool.available(subsidyManager), 40 ether);

    _setWethBalance(22 ether);
    assertEq(pool.available(fpcFunder), 22 ether);
    assertEq(pool.available(subsidyManager), 12 ether);

    _setWethBalance(8 ether);
    assertEq(pool.available(fpcFunder), 8 ether);
    assertEq(pool.available(subsidyManager), 0);
  }

  function test_balanceCountsEthAndWeth() public {
    _fundWeth(5 ether);
    _fundEth(3 ether);
    assertEq(pool.balance(), 8 ether);
  }

  function test_receiveAcceptsEthFromAnySender() public {
    address sender = makeAddr("sender");
    vm.deal(sender, 1 ether);
    vm.prank(sender);
    (bool ok,) = address(pool).call{value: 1 ether}("");
    assertTrue(ok);
    assertEq(address(pool).balance, 1 ether);
  }

  function test_pullPaysEthBeforeItUnwrapsWeth() public {
    _append(fpcFunder, 0, NO_CAP);
    _fundEth(3 ether);
    _fundWeth(5 ether);

    vm.expectEmit();
    emit IFeePool.Pulled(fpcFunder, 6 ether);
    vm.prank(fpcFunder);
    uint256 amount = pool.pull(6 ether);

    assertEq(amount, 6 ether);
    assertEq(fpcFunder.balance, 6 ether);
    assertEq(address(pool).balance, 0);
    assertEq(weth.balanceOf(address(pool)), 2 ether);
  }

  function test_pullMaxTakesTheUnprotectedBalance() public {
    _append(fpcFunder, 10 ether, NO_CAP);
    _append(subsidyManager, 15 ether, NO_CAP);
    _fundWeth(22 ether);

    vm.prank(subsidyManager);
    uint256 amount = pool.pull(type(uint256).max);

    assertEq(amount, 12 ether);
    assertEq(subsidyManager.balance, 12 ether);
    assertEq(pool.balance(), 10 ether, "the protected reserve stays in the pool");
  }

  function test_pullMaxTakesTheRateCap() public {
    _append(fpcFunder, 0, 4 ether);
    _fundWeth(10 ether);

    vm.prank(fpcFunder);
    assertEq(pool.pull(type(uint256).max), 4 ether);
  }

  function test_pullRevertsAboveAvailable() public {
    _append(fpcFunder, 10 ether, NO_CAP);
    _append(subsidyManager, 15 ether, NO_CAP);
    _fundWeth(22 ether);

    vm.expectRevert(abi.encodeWithSelector(Errors.FeePool__AmountAboveAvailable.selector, 13 ether, 12 ether));
    vm.prank(subsidyManager);
    pool.pull(13 ether);
  }

  function test_pullZeroRestartsTheIdleTimer() public {
    _append(fpcFunder, 0, NO_CAP);
    _fundWeth(1 ether);
    skip(IDLE_TIMEOUT);

    vm.recordLogs();
    vm.prank(fpcFunder);
    assertEq(pool.pull(0), 0);
    assertEq(vm.getRecordedLogs().length, 0, "an empty pull emits no event");
    assertEq(pool.balance(), 1 ether);

    skip(IDLE_TIMEOUT);
    vm.expectRevert(abi.encodeWithSelector(Errors.FeePool__SpenderNotReleasable.selector, fpcFunder));
    pool.release(fpcFunder);
  }

  function test_pullMaxWithNothingPullableRestartsTheIdleTimer() public {
    _append(fpcFunder, 0, NO_CAP);
    skip(IDLE_TIMEOUT);

    vm.recordLogs();
    vm.prank(fpcFunder);
    assertEq(pool.pull(type(uint256).max), 0);
    assertEq(vm.getRecordedLogs().length, 0, "an empty pull emits no event");
    assertEq(fpcFunder.balance, 0);

    skip(IDLE_TIMEOUT);
    vm.expectRevert(abi.encodeWithSelector(Errors.FeePool__SpenderNotReleasable.selector, fpcFunder));
    pool.release(fpcFunder);
  }

  function test_pullMaxWithNothingPullableKeepsTheRefill() public {
    _append(fpcFunder, 0, 7 ether);
    _fundWeth(7 ether);
    vm.prank(fpcFunder);
    pool.pull(7 ether);

    skip(PERIOD / 7 * 3);
    vm.prank(fpcFunder);
    assertEq(pool.pull(type(uint256).max), 0);

    _fundWeth(10 ether);
    assertEq(pool.available(fpcFunder), 3 ether, "the refill before the empty pull is kept");
  }

  function test_pullRevertsForAnUnknownSpender() public {
    _fundWeth(1 ether);
    vm.expectRevert(abi.encodeWithSelector(Errors.FeePool__NotALiveSpender.selector, nextSpender));
    vm.prank(nextSpender);
    pool.pull(1 ether);
  }

  function test_aNestedPullStaysWithinTheRateCap() public {
    ReentrantSpender spender = new ReentrantSpender(pool);
    _append(address(spender), 0, 6 ether);
    _fundWeth(20 ether);

    assertEq(spender.pull(4 ether), 4 ether);

    assertEq(spender.nestedAmount(), 2 ether);
    assertEq(address(spender).balance, 6 ether);
    assertEq(pool.available(address(spender)), 0);
  }

  function test_aNestedPullLeavesTheProtectedReserves() public {
    _append(fpcFunder, 5 ether, NO_CAP);
    ReentrantSpender spender = new ReentrantSpender(pool);
    _append(address(spender), 0, NO_CAP);
    _fundWeth(12 ether);

    assertEq(spender.pull(4 ether), 4 ether);

    assertEq(spender.nestedAmount(), 3 ether);
    assertEq(address(spender).balance, 7 ether);
    assertEq(pool.balance(), 5 ether);
  }

  function test_rateCapRefillsOverThePeriod() public {
    _append(fpcFunder, 0, 7 ether);
    _fundWeth(100 ether);

    vm.prank(fpcFunder);
    pool.pull(7 ether);
    assertEq(pool.available(fpcFunder), 0);

    skip(PERIOD / 7 * 3);
    assertEq(pool.available(fpcFunder), 3 ether);

    vm.prank(fpcFunder);
    pool.pull(1 ether);
    assertEq(pool.available(fpcFunder), 2 ether);

    skip(PERIOD * 10);
    assertEq(pool.available(fpcFunder), 7 ether, "the rate cap does not refill above amountPerPeriod");
  }

  function test_expiredSpenderCannotPull() public {
    _appendUntil(fpcFunder, 0, NO_CAP, uint64(block.timestamp + ACTIVE_FOR));
    _fundWeth(10 ether);

    skip(ACTIVE_FOR);
    assertEq(pool.available(fpcFunder), 10 ether, "the spender is live up to and at activeUntil");

    skip(1);
    assertEq(pool.available(fpcFunder), 0);
    vm.expectRevert(abi.encodeWithSelector(Errors.FeePool__NotALiveSpender.selector, fpcFunder));
    vm.prank(fpcFunder);
    pool.pull(1 ether);
  }

  function test_expiredReserveCountsUntilTheSpenderIsReleased() public {
    _appendUntil(fpcFunder, 10 ether, NO_CAP, uint64(block.timestamp + ACTIVE_FOR));
    _append(subsidyManager, 0, NO_CAP);
    _fundWeth(10 ether);

    skip(ACTIVE_FOR + 1);
    assertEq(pool.available(subsidyManager), 0, "an expired spender that is not released still holds its reserve");

    vm.expectEmit();
    emit IFeePool.Released(fpcFunder);
    vm.prank(makeAddr("anyone"));
    pool.release(fpcFunder);

    assertEq(pool.available(subsidyManager), 10 ether);
  }

  function test_renounceFreesTheReserve() public {
    _append(fpcFunder, 10 ether, NO_CAP);
    _append(subsidyManager, 0, NO_CAP);
    _fundWeth(10 ether);

    vm.expectEmit();
    emit IFeePool.Renounced(fpcFunder);
    vm.prank(fpcFunder);
    pool.renounce();

    _assertOrder(_list(subsidyManager));
    assertEq(pool.available(subsidyManager), 10 ether);
  }

  function test_renounceDoesNothingForAnUnlistedSpender() public {
    _append(fpcFunder, 10 ether, NO_CAP);
    skip(IDLE_TIMEOUT + 1);
    pool.release(fpcFunder);

    vm.recordLogs();
    vm.prank(fpcFunder);
    pool.renounce();
    vm.prank(nextSpender);
    pool.renounce();

    Vm.Log[] memory logs = vm.getRecordedLogs();
    assertEq(logs.length, 0, "a released or unknown spender renounces without a revert or an event");
  }

  function test_renounceAcceptsEth() public {
    _append(fpcFunder, 0, NO_CAP);
    vm.deal(fpcFunder, 2 ether);

    vm.prank(fpcFunder);
    pool.renounce{value: 2 ether}();

    assertEq(pool.balance(), 2 ether);
  }

  function test_appendDropsTheExpiredSpenders() public {
    _appendUntil(fpcFunder, 10 ether, NO_CAP, uint64(block.timestamp + ACTIVE_FOR));
    _append(subsidyManager, 15 ether, NO_CAP);
    _append(nextSpender, 0, NO_CAP);
    skip(ACTIVE_FOR + 1);

    vm.expectEmit();
    emit IFeePool.Released(fpcFunder);
    address lastSpender = makeAddr("lastSpender");
    _append(lastSpender, 0, NO_CAP);

    _assertOrder(_list(subsidyManager, nextSpender, lastSpender));
    assertEq(_spender(0).protectedReserves, 0);
    assertEq(_spender(1).protectedReserves, 15 ether);
    assertEq(_spender(2).protectedReserves, 15 ether);
  }

  function test_renounceDropsTheExpiredSpenders() public {
    _appendUntil(fpcFunder, 10 ether, NO_CAP, uint64(block.timestamp + ACTIVE_FOR));
    _append(subsidyManager, 15 ether, NO_CAP);
    _append(nextSpender, 0, NO_CAP);
    skip(ACTIVE_FOR + 1);

    vm.expectEmit();
    emit IFeePool.Released(fpcFunder);
    vm.expectEmit();
    emit IFeePool.Renounced(subsidyManager);
    vm.prank(subsidyManager);
    pool.renounce();

    _assertOrder(_list(nextSpender));
    assertEq(_spender(0).protectedReserves, 0);
  }

  function test_renounceByAnExpiredSpenderEmitsOnlyRenounced() public {
    _appendUntil(fpcFunder, 10 ether, NO_CAP, uint64(block.timestamp + ACTIVE_FOR));
    _append(subsidyManager, 0, NO_CAP);
    skip(ACTIVE_FOR + 1);

    vm.recordLogs();
    vm.prank(fpcFunder);
    pool.renounce();

    Vm.Log[] memory logs = vm.getRecordedLogs();
    assertEq(logs.length, 1);
    assertEq(logs[0].topics[0], IFeePool.Renounced.selector);
    _assertOrder(_list(subsidyManager));
    assertEq(_spender(0).protectedReserves, 0);
  }

  function test_releaseOfAnExpiredSpenderEmitsOneReleased() public {
    _appendUntil(fpcFunder, 10 ether, NO_CAP, uint64(block.timestamp + ACTIVE_FOR));
    skip(ACTIVE_FOR + 1);

    vm.recordLogs();
    pool.release(fpcFunder);

    Vm.Log[] memory logs = vm.getRecordedLogs();
    assertEq(logs.length, 1);
    assertEq(logs[0].topics[0], IFeePool.Released.selector);
  }

  function test_releaseDropsTheExpiredSpenders() public {
    _appendUntil(fpcFunder, 10 ether, NO_CAP, uint64(block.timestamp + ACTIVE_FOR));
    _append(subsidyManager, 15 ether, NO_CAP);
    _append(nextSpender, 0, NO_CAP);
    skip(IDLE_TIMEOUT + 1);

    vm.expectEmit();
    emit IFeePool.Released(fpcFunder);
    vm.expectEmit();
    emit IFeePool.Released(subsidyManager);
    pool.release(subsidyManager);

    _assertOrder(_list(nextSpender));
    assertEq(_spender(0).protectedReserves, 0);
  }

  function test_maxIdleTimeoutDisablesTheIdleRelease() public {
    IFeePool.SpenderConfig memory config = _config(fpcFunder, 0, NO_CAP, NO_EXPIRY);
    config.idleTimeout = type(uint64).max;
    vm.prank(owner);
    pool.append(config, 0);

    skip(100 * 365 days);
    vm.expectRevert(abi.encodeWithSelector(Errors.FeePool__SpenderNotReleasable.selector, fpcFunder));
    pool.release(fpcFunder);
  }

  function test_anyoneReleasesAnIdleSpender() public {
    _append(fpcFunder, 10 ether, NO_CAP);
    _append(subsidyManager, 0, NO_CAP);
    _fundWeth(10 ether);

    skip(IDLE_TIMEOUT);
    vm.expectRevert(abi.encodeWithSelector(Errors.FeePool__SpenderNotReleasable.selector, fpcFunder));
    pool.release(fpcFunder);

    skip(1);
    vm.expectEmit();
    emit IFeePool.Released(fpcFunder);
    vm.prank(makeAddr("anyone"));
    pool.release(fpcFunder);

    _assertOrder(_list(subsidyManager));
    assertEq(pool.balance(), 10 ether, "the funds stay in the pool");
    assertEq(pool.available(subsidyManager), 10 ether);
  }

  function test_theIdleTimerStartsAfterTheIdleDelay() public {
    vm.prank(owner);
    pool.append(_config(fpcFunder, 0, NO_CAP, NO_EXPIRY), IDLE_DELAY);

    skip(IDLE_DELAY + IDLE_TIMEOUT);
    vm.expectRevert(abi.encodeWithSelector(Errors.FeePool__SpenderNotReleasable.selector, fpcFunder));
    pool.release(fpcFunder);

    skip(1);
    pool.release(fpcFunder);
    _assertOrder(new address[](0));
  }

  function test_aSpenderPullsDuringTheIdleDelay() public {
    vm.prank(owner);
    pool.append(_config(fpcFunder, 0, 4 ether, NO_EXPIRY), IDLE_DELAY);
    _fundWeth(10 ether);

    assertEq(pool.available(fpcFunder), 4 ether, "the rate cap does not refill during the idle delay");
    vm.prank(fpcFunder);
    pool.pull(1 ether);
    assertEq(_spender(0).lastPulledAt, block.timestamp, "the pull restarts the idle timer");

    skip(IDLE_TIMEOUT + 1);
    pool.release(fpcFunder);
  }

  function test_pullRestartsTheIdleTimer() public {
    _append(fpcFunder, 0, NO_CAP);
    _fundWeth(1 ether);

    skip(IDLE_TIMEOUT);
    vm.prank(fpcFunder);
    pool.pull(1);

    skip(IDLE_TIMEOUT);
    vm.expectRevert(abi.encodeWithSelector(Errors.FeePool__SpenderNotReleasable.selector, fpcFunder));
    pool.release(fpcFunder);
  }

  function test_releaseRevertsForAnUnknownOrRenouncedSpender() public {
    vm.expectRevert(abi.encodeWithSelector(Errors.FeePool__SpenderNotListed.selector, fpcFunder));
    pool.release(fpcFunder);

    _append(fpcFunder, 0, NO_CAP);
    vm.prank(fpcFunder);
    pool.renounce();
    skip(IDLE_TIMEOUT + 1);
    vm.expectRevert(abi.encodeWithSelector(Errors.FeePool__SpenderNotListed.selector, fpcFunder));
    pool.release(fpcFunder);
  }

  function test_renounceUpdatesTheProtectedReservesOfLaterSpenders() public {
    _append(fpcFunder, 10 ether, NO_CAP);
    _append(subsidyManager, 15 ether, NO_CAP);
    _append(nextSpender, 0, NO_CAP);
    assertEq(_spender(1).protectedReserves, 10 ether);
    assertEq(_spender(2).protectedReserves, 25 ether);

    vm.prank(subsidyManager);
    pool.renounce();

    _assertOrder(_list(fpcFunder, nextSpender));
    assertEq(_spender(0).protectedReserves, 0);
    assertEq(_spender(1).protectedReserves, 10 ether);

    address lastSpender = makeAddr("lastSpender");
    _append(lastSpender, 0, NO_CAP);
    assertEq(_spender(2).protectedReserves, 10 ether);
  }

  function test_renewalAfterExpiryGoesToTheTail() public {
    _appendUntil(fpcFunder, 10 ether, NO_CAP, uint64(block.timestamp + ACTIVE_FOR));
    _append(subsidyManager, 15 ether, NO_CAP);
    skip(ACTIVE_FOR + 1);

    vm.expectEmit();
    emit IFeePool.Released(fpcFunder);
    _appendUntil(fpcFunder, 10 ether, NO_CAP, NO_EXPIRY);
    _assertOrder(_list(subsidyManager, fpcFunder));
    assertEq(_spender(1).protectedReserves, 15 ether);

    _fundWeth(20 ether);
    assertEq(pool.available(subsidyManager), 20 ether);
    assertEq(pool.available(fpcFunder), 5 ether, "the renewed spender comes after the subsidy manager");
  }

  function testFuzz_pullNeverTouchesTheProtectedReserves(
    uint96 _balance,
    uint96 _firstReserve,
    uint96 _middleReserve,
    uint96 _amount,
    bool _middleRenounced,
    bool _middleExpired
  ) public {
    _append(fpcFunder, _firstReserve, NO_CAP);
    _appendUntil(subsidyManager, _middleReserve, NO_CAP, uint64(block.timestamp + ACTIVE_FOR));
    _append(nextSpender, 0, NO_CAP);
    if (_middleRenounced) {
      vm.prank(subsidyManager);
      pool.renounce();
    }
    if (_middleExpired) {
      skip(ACTIVE_FOR + 1);
    }
    _fundWeth(_balance);

    uint256 protectedReserves = uint256(_firstReserve) + (_middleRenounced ? 0 : _middleReserve);
    uint256 expected = _balance > protectedReserves ? _balance - protectedReserves : 0;
    assertEq(pool.available(nextSpender), expected);

    if (expected == 0) {
      return;
    }
    vm.prank(nextSpender);
    pool.pull(bound(_amount, 1, expected));
    assertGe(pool.balance(), protectedReserves);
  }

  function _spender(uint256 _index) internal view returns (IFeePool.Spender memory) {
    return pool.spenders()[_index];
  }

  function _assertOrder(address[] memory _expected) internal view {
    IFeePool.Spender[] memory spenders = pool.spenders();
    assertEq(spenders.length, _expected.length);
    for (uint256 i = 0; i < _expected.length; i++) {
      assertEq(spenders[i].config.spender, _expected[i]);
    }
  }

  function _list(address _a) internal pure returns (address[] memory list) {
    list = new address[](1);
    list[0] = _a;
  }

  function _list(address _a, address _b) internal pure returns (address[] memory list) {
    list = new address[](2);
    list[0] = _a;
    list[1] = _b;
  }

  function _list(address _a, address _b, address _c) internal pure returns (address[] memory list) {
    list = new address[](3);
    list[0] = _a;
    list[1] = _b;
    list[2] = _c;
  }

  function _append(address _spender, uint192 _reserve, uint192 _amountPerPeriod) internal {
    _appendUntil(_spender, _reserve, _amountPerPeriod, NO_EXPIRY);
  }

  function _appendUntil(address _spender, uint192 _reserve, uint192 _amountPerPeriod, uint64 _activeUntil) internal {
    vm.prank(owner);
    pool.append(_config(_spender, _reserve, _amountPerPeriod, _activeUntil), 0);
  }

  function _expectAppendRevert(IFeePool.SpenderConfig memory _cfg, bytes memory _err) internal {
    _expectAppendRevert(_cfg, 0, _err);
  }

  function _expectAppendRevert(IFeePool.SpenderConfig memory _cfg, uint64 _idleDelay, bytes memory _err) internal {
    vm.expectRevert(_err);
    vm.prank(owner);
    pool.append(_cfg, _idleDelay);
  }

  function _config(address _spender, uint192 _reserve, uint192 _amountPerPeriod, uint64 _activeUntil)
    internal
    pure
    returns (IFeePool.SpenderConfig memory)
  {
    return IFeePool.SpenderConfig({
      spender: _spender,
      idleTimeout: IDLE_TIMEOUT,
      reserve: _reserve,
      activeUntil: _activeUntil,
      amountPerPeriod: _amountPerPeriod,
      period: PERIOD
    });
  }

  function _fundWeth(uint256 _amount) internal {
    vm.deal(address(this), _amount);
    weth.deposit{value: _amount}();
    weth.transfer(address(pool), _amount);
  }

  function _fundEth(uint256 _amount) internal {
    vm.deal(address(pool), address(pool).balance + _amount);
  }

  function _setWethBalance(uint256 _amount) internal {
    uint256 current = weth.balanceOf(address(pool));
    if (_amount < current) {
      vm.prank(address(pool));
      weth.transfer(address(0xdead), current - _amount);
    } else if (_amount > current) {
      _fundWeth(_amount - current);
    }
  }
}
