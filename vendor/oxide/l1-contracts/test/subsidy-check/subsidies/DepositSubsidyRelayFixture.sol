// SPDX-License-Identifier: Apache-2.0
pragma solidity >=0.8.27;
import {SweepGasCeilings} from "@test/helpers/SweepGasCeilings.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {DepositSIPA} from "@periphery/DepositSIPA.sol";
import {DepositSubsidy} from "@periphery/DepositSubsidy.sol";
import {OperationExecutor} from "@periphery/OperationExecutor.sol";
import {AggregatorV3Interface} from "@periphery/interfaces/AggregatorV3Interface.sol";
import {IOperationExecutor} from "@periphery/interfaces/IOperationExecutor.sol";
import {ISIPA} from "@periphery/interfaces/ISIPA.sol";

import {SweepGasFixture} from "@test/periphery/SweepGasFixture.sol";
import {RelayerTransaction} from "@test/periphery/RelayerTransaction.sol";
import {MockV3Aggregator} from "@test/mocks/MockV3Aggregator.sol";
import {DEPOSIT_SWEEP_TIP} from "@test/helpers/ForwardingTableFixture.sol";
import {Intents} from "@periphery/Intent.sol";

interface VmCooling {
  function cool(address) external;
}

abstract contract DepositSubsidyRelayFixture is SweepGasFixture {
  uint256 internal constant DEPOSIT = 100 ether;
  uint256 internal constant UNDERPAY_TOLERANCE = 2000;

  DepositSubsidy internal sm;
  MockV3Aggregator internal feed;
  address internal payer;

  bytes internal resweepIntent;
  DepositSIPA internal resweepSipa;
  bytes internal firstIntent;
  address internal firstSipa;

  function setUp() public virtual override {
    super.setUp();
    feed = new MockV3Aggregator(8, PRICED_FEED_ANSWER);
    sm = new DepositSubsidy(
      OWNER,
      address(portal),
      IOperationExecutor(address(operationExecutor)),
      AggregatorV3Interface(address(feed)),
      sipaFactory,
      SweepGasCeilings.initial()
    );
    underlying.mint(address(sm), 1_000_000 ether);
    vm.prank(OWNER);
    sm.setDepositConfig(PRICED_MIN_PROFIT, type(uint128).max, 0);
    vm.fee(PRICED_BASEFEE);
    vm.txGasPrice(PRICED_BASEFEE);

    payer = makeAddr("payer");
    underlying.mint(payer, 1);

    _warmInbox(8);

    resweepIntent = _depositIntent("resweep");
    resweepSipa = _depositSIPA(resweepIntent);
    underlying.mint(address(resweepSipa), DEPOSIT);
    resweepSipa.sweep(address(underlying), payer, resweepIntent, "");
    underlying.mint(address(resweepSipa), DEPOSIT);

    firstIntent = _depositIntent("first");
    firstSipa = _predictDepositSIPA(firstIntent);
    underlying.mint(firstSipa, DEPOSIT);
  }

  function _assertPricedAtTheTransactionGas(uint256 _txGas, uint256 _priced) internal pure {
    assertLe(_priced, _txGas, "the subsidy priced more gas than the transaction used: a self-relay farms it");
    assertGe(_priced + UNDERPAY_TOLERANCE, _txGas, "the subsidy priced well below the transaction gas");
  }

  function _relayFrom(address _from, address _sipa, bytes memory _inner)
    internal
    returns (uint256 txGas, uint256 priced)
  {
    return _sendFrom(_from, _sipa, _executeCd(_inner, IERC20(address(underlying))));
  }

  function _sendFrom(address _from, address _sipa, bytes memory _outer)
    internal
    returns (uint256 txGas, uint256 priced)
  {
    _coolAll(_sipa);
    VmCooling(address(vm)).cool(_from);
    vm.prank(_from, _from);
    (bool ok, bytes memory ret) = address(operationExecutor).call(_outer);
    require(ok, "relay reverted");
    txGas = RelayerTransaction.lastTxGas(_outer);
    priced = _pricedGas(abi.decode(ret, (uint256)) - DEPOSIT_SWEEP_TIP, DEPOSIT_SWEEP_TIP);
  }

  function _executeCd(bytes memory _inner, IERC20 _payoutToken) internal view returns (bytes memory) {
    return abi.encodeCall(OperationExecutor.execute, (address(sm), _inner, _payoutToken, 0, 0, 0));
  }

  function _resweepCd(address _relayer, bytes memory _proofs) internal view returns (bytes memory) {
    return abi.encodeCall(
      DepositSubsidy.sweepForSubsidy,
      (ISIPA(address(resweepSipa)), address(underlying), _relayer, resweepIntent, _proofs)
    );
  }

  function _deployCd(bytes memory _intentData) internal view returns (bytes memory) {
    return _deployCd(_intentData, "");
  }

  function _deployCd(bytes memory _intentData, bytes memory _proofs) internal view returns (bytes memory) {
    return abi.encodeCall(
      DepositSubsidy.deployAndSweepForSubsidy,
      (
        forwardingTable,
        Intents.DEPOSIT,
        _recoveryCommitment("recovery"),
        true,
        address(underlying),
        address(operationExecutor),
        _intentData,
        _proofs
      )
    );
  }

  function _depositIntent(bytes32 _salt) internal pure returns (bytes memory) {
    return abi.encode(_field(_salt));
  }

  function _depositSIPA(bytes memory _intent) internal returns (DepositSIPA) {
    return DepositSIPA(
      sipaFactory.deploySIPA(
        address(depositSIPAImplementation),
        keccak256(_intent),
        _recoveryCommitment("recovery"),
        ROLLUP_VERSION,
        true,
        forwardingTable
      )
    );
  }

  function _predictDepositSIPA(bytes memory _intent) internal view returns (address) {
    return sipaFactory.predictSIPA(
      address(depositSIPAImplementation),
      keccak256(_intent),
      _recoveryCommitment("recovery"),
      ROLLUP_VERSION,
      true,
      forwardingTable
    );
  }

  function _warmInbox(uint256 _n) internal {
    DepositSIPA s = _depositSIPA(_depositIntent("inboxWarm"));
    for (uint256 i = 0; i < _n; i++) {
      underlying.mint(address(s), DEPOSIT);
      s.sweep(address(underlying), payer, _depositIntent("inboxWarm"), "");
    }
  }

  function _coolAll(address _sipa) internal {
    address[12] memory a = [
      _sipa,
      address(sipaFactory),
      address(depositSIPAImplementation),
      address(portal),
      address(forwardingTable),
      address(wiredInbox),
      address(rollup),
      address(registry),
      address(underlying),
      address(sm),
      address(feed),
      address(operationExecutor)
    ];
    for (uint256 i = 0; i < a.length; i++) {
      VmCooling(address(vm)).cool(a[i]);
    }
  }
}
