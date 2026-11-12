// SPDX-License-Identifier: Apache-2.0
pragma solidity >=0.8.27;

import {Vm} from "forge-std/Vm.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Address} from "@openzeppelin/contracts/utils/Address.sol";
import {IOxidePortal} from "@core/interfaces/IOxidePortal.sol";
import {DepositSIPA} from "@periphery/DepositSIPA.sol";
import {DepositSubsidy} from "@periphery/DepositSubsidy.sol";
import {ForwardingTable} from "@periphery/ForwardingTable.sol";
import {OperationExecutor} from "@periphery/OperationExecutor.sol";
import {SIPAFactory} from "@periphery/SIPAFactory.sol";
import {IForwardingTable} from "@periphery/interfaces/IForwardingTable.sol";
import {ISIPA} from "@periphery/interfaces/ISIPA.sol";
import {Intent, Intents} from "@periphery/Intent.sol";
import {ForwardingTableFixture, DEPOSIT_SWEEP_TIP} from "@test/helpers/ForwardingTableFixture.sol";
import {DepositSubsidyRelayFixture} from "@test/subsidy-check/subsidies/DepositSubsidyRelayFixture.sol";
import {SubsidyFarmSafety} from "@test/subsidy-check/subsidies/SubsidyFarmSafety.sol";

contract ReenteringSIPA {
  address internal immutable SUBSIDY;
  address internal immutable PORTAL;
  bytes internal reentry;
  bool internal entered;

  constructor(address _subsidy, address _portal) {
    SUBSIDY = _subsidy;
    PORTAL = _portal;
  }

  function setReentry(bytes calldata _reentry) external {
    reentry = _reentry;
  }

  function route(address) external view returns (address, uint256, uint256) {
    return (PORTAL, DEPOSIT_SWEEP_TIP, 0);
  }

  function sweep(address, address, bytes calldata, bytes calldata) external {
    if (entered) {
      return;
    }
    entered = true;
    Address.functionCall(SUBSIDY, reentry);
  }
}

contract DepositSubsidyFarmSafetyTest is DepositSubsidyRelayFixture, SubsidyFarmSafety {
  uint256 internal constant RESWEEP = 0;
  uint256 internal constant FIRST_SWEEP = 1;
  uint256 internal constant FRONT_RUN_FIRST_SWEEP = 2;
  uint256 internal constant ENTRIES = 3;

  uint256 internal constant RELAYER_ARGUMENT_IS_NOT_THE_EXECUTOR = 0;
  uint256 internal constant SIPA_OF_ANOTHER_FACTORY = 1;
  uint256 internal constant SIPA_OF_ANOTHER_PORTAL = 2;
  uint256 internal constant TABLE_NOT_APPROVED = 3;
  uint256 internal constant INTENT_WITHOUT_AN_IMPLEMENTATION = 4;
  uint256 internal constant SWEEP_THAT_REENTERS_THE_SWEEP_ENTRY = 5;
  uint256 internal constant SWEEP_THAT_REENTERS_THE_DEPLOY_ENTRY = 6;
  uint256 internal constant DEPLOY_ENTRY_SWEEP_THAT_REENTERS = 7;
  uint256 internal constant FAILING_SWEEP = 8;
  uint256 internal constant CREDIT_BELOW_THE_MINIMUM = 9;
  uint256 internal constant OWN_SHAPES = 10;

  uint256 internal entry;
  uint256 internal amount;
  bytes32 internal salt;
  address[] internal staged;
  address[] internal stagedRelayers;

  function _subsidy() internal view override returns (address) {
    return address(sm);
  }

  function _payoutToken() internal view override returns (IERC20) {
    return IERC20(address(underlying));
  }

  function _executor() internal view override returns (OperationExecutor) {
    return operationExecutor;
  }

  function _pot() internal view override returns (uint256) {
    return underlying.balanceOf(address(sm));
  }

  function _relayFee() internal pure override returns (uint256) {
    return DEPOSIT_SWEEP_TIP;
  }

  function _stage(uint256 _seed) internal override {
    entry = _seed % ENTRIES;
    amount = bound(uint256(keccak256(abi.encode(_seed, "amount"))), 1 ether, DEPOSIT);
    salt = keccak256(abi.encode(_seed, "salt"));
    delete staged;
    delete stagedRelayers;
    vm.getRecordedLogs();
    vm.recordLogs();
  }

  function _relayCall(address _relayer, uint256 _index) internal override returns (bytes memory) {
    bytes memory intent = _depositIntent(keccak256(abi.encode(salt, _index)));
    if (entry == RESWEEP) {
      DepositSIPA sipa = _depositSIPA(intent);
      underlying.mint(address(sipa), DEPOSIT);
      sipa.sweep(address(underlying), payer, intent, "");
      underlying.mint(address(sipa), amount);
      staged.push(address(sipa));
      stagedRelayers.push(_relayer);
      return
        abi.encodeCall(
          DepositSubsidy.sweepForSubsidy, (ISIPA(address(sipa)), address(underlying), _relayer, intent, "")
        );
    }
    if (entry == FRONT_RUN_FIRST_SWEEP) {
      _depositSIPA(intent);
    }
    address predicted = _predictDepositSIPA(intent);
    underlying.mint(predicted, amount);
    staged.push(predicted);
    stagedRelayers.push(_relayer);
    return _deployCall(forwardingTable, Intents.DEPOSIT, intent, _relayer);
  }

  function _assertTheOperationsRan() internal override {
    assertGt(staged.length, 0, "no relay was staged, so the check tests nothing");
    Vm.Log[] memory logs = vm.getRecordedLogs();
    for (uint256 i = 0; i < staged.length; i++) {
      assertEq(underlying.balanceOf(staged[i]), 0, "a call that is not a relayer transaction did not sweep its SIPA");
      assertTrue(
        _paidTheFee(logs, staged[i], stagedRelayers[i]), "a SIPA did not pay its fee to the relayer that the call names"
      );
    }
  }

  function _paidTheFee(Vm.Log[] memory _logs, address _sipa, address _relayer) internal view returns (bool) {
    for (uint256 i = 0; i < _logs.length; i++) {
      Vm.Log memory log = _logs[i];
      if (
        log.emitter == address(underlying) && log.topics.length == 3
          && log.topics[0] == keccak256("Transfer(address,address,uint256)")
          && log.topics[1] == bytes32(uint256(uint160(_sipa))) && log.topics[2] == bytes32(uint256(uint160(_relayer)))
          && abi.decode(log.data, (uint256)) == DEPOSIT_SWEEP_TIP
      ) {
        return true;
      }
    }
    return false;
  }

  function _stillRuns(uint256 _shape) internal pure override returns (bool) {
    if (_shape >= SHARED_SHAPES) {
      uint256 own = _shape - SHARED_SHAPES;
      return own == RELAYER_ARGUMENT_IS_NOT_THE_EXECUTOR || own == CREDIT_BELOW_THE_MINIMUM;
    }
    return _shape != NESTED_EXECUTE && _shape != REPLAY;
  }

  function _ownShapes() internal pure override returns (uint256) {
    return OWN_SHAPES;
  }

  function _sendOwnShape(uint256 _shape, address _caller, uint256 _seed) internal override returns (bool) {
    if (_shape == RELAYER_ARGUMENT_IS_NOT_THE_EXECUTOR) {
      return _relay(_caller, _relayCall(_caller, 0));
    }
    if (_shape == SIPA_OF_ANOTHER_FACTORY) {
      uint256 ceiling = sm.$sweepGasCeilings(Intents.DEPOSIT);
      vm.prank(OWNER);
      sm.setSweepGasCeiling(Intents.NONE, ceiling);
      return _relay(_caller, _sweepOfAnotherFactory());
    }
    if (_shape == SIPA_OF_ANOTHER_PORTAL) {
      return _relay(_caller, _sweepOfAnotherPortal());
    }
    if (_shape == TABLE_NOT_APPROVED) {
      IForwardingTable table = ForwardingTableFixture.deploy(OWNER, IOxidePortal(address(portal)), TABLE_BENEFICIARY);
      return _relay(_caller, _fundedDeployCall(table, Intents.DEPOSIT));
    }
    if (_shape == INTENT_WITHOUT_AN_IMPLEMENTATION) {
      uint8 intent = uint8(bound(_seed, 2, 255));
      return _relay(_caller, _fundedDeployCall(forwardingTable, Intent.wrap(intent == 2 ? 0 : intent)));
    }
    if (_shape == SWEEP_THAT_REENTERS_THE_SWEEP_ENTRY) {
      ReenteringSIPA sipa = _reenteringSIPA(address(new ReenteringSIPA(address(sm), address(portal))));
      sipa.setReentry(_sweepOf(address(sipa), address(operationExecutor)));
      return _relay(_caller, _sweepOf(address(sipa), address(operationExecutor)));
    }
    if (_shape == SWEEP_THAT_REENTERS_THE_DEPLOY_ENTRY) {
      ReenteringSIPA sipa = _reenteringSIPA(address(new ReenteringSIPA(address(sm), address(portal))));
      sipa.setReentry(_fundedDeployCall(forwardingTable, Intents.DEPOSIT));
      return _relay(_caller, _sweepOf(address(sipa), address(operationExecutor)));
    }
    if (_shape == DEPLOY_ENTRY_SWEEP_THAT_REENTERS) {
      bytes memory intent = _depositIntent(keccak256(abi.encode(salt, "reentering")));
      address predicted = _predictDepositSIPA(intent);
      vm.etch(predicted, address(new ReenteringSIPA(address(sm), address(portal))).code);
      _reenteringSIPA(predicted).setReentry(_sweepOf(predicted, address(operationExecutor)));
      return _relay(_caller, _deployCall(forwardingTable, Intents.DEPOSIT, intent, address(operationExecutor)));
    }
    if (_shape == FAILING_SWEEP) {
      amount = bound(_seed, 1, DEPOSIT_SWEEP_TIP);
      return _relay(_caller, _relayCall(address(operationExecutor), 0));
    }
    bytes memory relay = _relayCall(address(operationExecutor), 0);
    _setMinimumCredit(_creditOf(_caller, relay) + bound(_seed, 1, 1 ether));
    return _relay(_caller, relay);
  }

  function test_GivenACreditAtTheMinimum_ThenTheRelayIsPaidAsWithNoMinimumAndOneTokenWeiBelowIsNot() external {
    address relayer = _farmer(0);
    for (uint256 e = 0; e < ENTRIES; e++) {
      uint256 staged = vm.snapshotState();
      _stage(e);
      bytes memory relay = _relayCall(address(operationExecutor), 0);
      uint256 credit = _creditOf(relayer, relay);
      assertGt(credit, 0, "the relay credits nothing, so the boundary tests nothing");

      uint256 unbounded = _drawAtTheMinimum(relayer, relay, 0);
      assertGt(unbounded, 0, "with no minimum the relay draws nothing, so the boundary tests nothing");
      assertEq(_drawAtTheMinimum(relayer, relay, credit - 1), unbounded, "a credit above the minimum is paid less");
      assertEq(_drawAtTheMinimum(relayer, relay, credit), unbounded, "a credit at the minimum is paid less");
      assertEq(_drawAtTheMinimum(relayer, relay, credit + 1), 0, "a credit 1 token-wei under the minimum is paid");
      vm.revertToState(staged);
    }
  }

  function _drawAtTheMinimum(address _relayer, bytes memory _inner, uint256 _minimum) internal returns (uint256 draw) {
    uint256 snapshot = vm.snapshotState();
    _setMinimumCredit(_minimum);
    uint256 potBefore = _pot();
    _relay(_relayer, _inner);
    draw = potBefore - _pot();
    vm.revertToState(snapshot);
  }

  function _relay(address _caller, bytes memory _inner) internal returns (bool) {
    return _send(_caller, address(operationExecutor), _outer(_inner, _payoutToken()));
  }

  function _creditOf(address _caller, bytes memory _inner) internal returns (uint256 credit) {
    uint256 snapshot = vm.snapshotState();
    uint256 before = underlying.balanceOf(address(portal));
    require(_relay(_caller, _inner), "the relay to measure reverted");
    credit = underlying.balanceOf(address(portal)) - before;
    vm.revertToState(snapshot);
  }

  function _setMinimumCredit(uint256 _minimum) internal {
    vm.prank(OWNER);
    sm.setDepositConfig(PRICED_MIN_PROFIT, type(uint128).max, uint128(_minimum));
  }

  function _sweepOf(address _sipa, address _relayer) internal view returns (bytes memory) {
    return abi.encodeCall(DepositSubsidy.sweepForSubsidy, (ISIPA(_sipa), address(underlying), _relayer, "", ""));
  }

  function _deployCall(IForwardingTable _table, Intent _intent, bytes memory _intentData, address _relayer)
    internal
    view
    returns (bytes memory)
  {
    return abi.encodeCall(
      DepositSubsidy.deployAndSweepForSubsidy,
      (_table, _intent, _recoveryCommitment("recovery"), true, address(underlying), _relayer, _intentData, "")
    );
  }

  function _fundedDeployCall(IForwardingTable _table, Intent _intent) internal returns (bytes memory) {
    bytes memory intent = _depositIntent(keccak256(abi.encode(salt, "deploy")));
    address predicted = sipaFactory.predictSIPA(
      sipaFactory.implementationFor(_intent),
      keccak256(intent),
      _recoveryCommitment("recovery"),
      ROLLUP_VERSION,
      true,
      _table
    );
    underlying.mint(predicted, amount);
    return _deployCall(_table, _intent, intent, address(operationExecutor));
  }

  function _sweepOfAnotherFactory() internal returns (bytes memory) {
    SIPAFactory other = new SIPAFactory(OWNER);
    vm.startPrank(OWNER);
    other.blessImplementation(address(depositSIPAImplementation));
    other.blessTable(forwardingTable);
    vm.stopPrank();
    bytes memory intent = _depositIntent(keccak256(abi.encode(salt, "otherFactory")));
    address sipa = other.deploySIPA(
      address(depositSIPAImplementation),
      keccak256(intent),
      _recoveryCommitment("recovery"),
      ROLLUP_VERSION,
      true,
      forwardingTable
    );
    underlying.mint(sipa, amount);
    return abi.encodeCall(
      DepositSubsidy.sweepForSubsidy, (ISIPA(sipa), address(underlying), address(operationExecutor), intent, "")
    );
  }

  function _sweepOfAnotherPortal() internal returns (bytes memory) {
    ForwardingTable table =
      ForwardingTableFixture.deploy(OWNER, IOxidePortal(address(_buildPortal(address(underlying)))), TABLE_BENEFICIARY);
    vm.prank(OWNER);
    sipaFactory.blessTable(table);
    bytes memory intent = _depositIntent(keccak256(abi.encode(salt, "otherPortal")));
    address sipa = sipaFactory.deploySIPA(
      address(depositSIPAImplementation),
      keccak256(intent),
      _recoveryCommitment("recovery"),
      ROLLUP_VERSION,
      true,
      table
    );
    underlying.mint(sipa, amount);
    return abi.encodeCall(
      DepositSubsidy.sweepForSubsidy, (ISIPA(sipa), address(underlying), address(operationExecutor), intent, "")
    );
  }

  function _reenteringSIPA(address _sipa) internal returns (ReenteringSIPA) {
    vm.mockCall(address(sipaFactory), abi.encodeCall(SIPAFactory.sipaIntentOf, (_sipa)), abi.encode(Intents.DEPOSIT));
    return ReenteringSIPA(_sipa);
  }
}
