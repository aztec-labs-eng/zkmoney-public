// SPDX-License-Identifier: Apache-2.0
pragma solidity >=0.8.27;
import {console2} from "forge-std/console2.sol";
import {IERC20} from "@oz/token/ERC20/IERC20.sol";
import {Math} from "@oz/utils/math/Math.sol";
import {IERC20 as IERC20OZ} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {IOxidePortal} from "@core/interfaces/IOxidePortal.sol";
import {DepositSIPA} from "@periphery/DepositSIPA.sol";
import {DepositSubsidy} from "@periphery/DepositSubsidy.sol";
import {OperationExecutor} from "@periphery/OperationExecutor.sol";
import {OxideAccountFactory} from "@periphery/OxideAccountFactory.sol";
import {RegistrationController} from "@periphery/RegistrationController.sol";
import {Intent, Intents} from "@periphery/Intent.sol";
import {SIPABase} from "@periphery/SIPABase.sol";
import {DAI, USDC, USDT, THREE_POOL} from "@periphery/ThreePoolLib.sol";
import {IForwardingTable} from "@periphery/interfaces/IForwardingTable.sol";
import {INameRegistry} from "@periphery/interfaces/INameRegistry.sol";
import {IOperationExecutor} from "@periphery/interfaces/IOperationExecutor.sol";
import {ISIPA} from "@periphery/interfaces/ISIPA.sol";

import {DaiRelayForkFixture} from "@test/fork/DaiRelayForkFixture.sol";
import {RelayerTransaction} from "@test/periphery/RelayerTransaction.sol";
import {ForwardingTableFixture} from "@test/helpers/ForwardingTableFixture.sol";

interface VmCooling {
  function cool(address) external;
}

abstract contract DepositSubsidyGasRowsFixture is DaiRelayForkFixture {
  string internal constant GAS_ROWS = "subsidy-check/gas.json";
  string internal constant SEEDS = "../environments/deployments/seeds/v6-prod/";
  IERC20 internal constant SUSDS = IERC20(0xa3931d71877C0E7a3148CB7Eb4463524FEc27fbD);
  bytes32 internal constant USDC_IMPLEMENTATION_SLOT =
    0x7050c9e0f4ca769c69bd3a8ef740bc37934f8e2c036e5a723fd8ee048ed3f8c3;
  bytes32 internal constant ERC1967_IMPLEMENTATION_SLOT =
    0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc;
  uint256 internal constant DEPOSIT = 100 ether;
  uint256 internal constant STABLE_DEPOSIT = 100e6;

  uint128 internal constant DAI_DEPOSIT_SWEEP_TIP = 25e16;
  uint128 internal constant DAI_DEPOSIT_BENEFICIARY_FEE = 15e16;
  uint128 internal constant DAI_REGISTRATION_SWEEP_TIP = 5e17;
  uint128 internal constant SUSDS_DEPOSIT_SWEEP_TIP = 25e16;

  struct Relay {
    DepositSubsidy subsidy;
    Intent intent;
    address input;
    address sipa;
    bool deployed;
    bytes inner;
    bytes outer;
  }

  struct Measurement {
    string row;
    DepositSubsidy subsidy;
    Intent intent;
    address input;
    bool deployed;
    uint256 txGas;
    uint256 priced;
    bytes outer;
  }

  DepositSubsidy internal daiSubsidy;
  DepositSubsidy internal susdsSubsidy;
  IOxidePortal internal susdsPortal;
  address internal payer;
  address internal gasRelayer;
  address internal holderRelayer;
  address internal usdcImplementation;
  address internal susdsImplementation;
  address internal accountImplementation;
  mapping(string row => Relay relay) internal relays;

  function setUp() public virtual override {
    super.setUp();
    RelayerTransaction.requireIsolation();
    susdsPortal = IOxidePortal(address(_buildPortal(address(SUSDS))));
    forwardingTable =
      ForwardingTableFixture.deploy(OWNER, IOxidePortal(address(portal)), TABLE_BENEFICIARY, _daiRowIntents());
    vm.startPrank(OWNER);
    forwardingTable.addRow(address(SUSDS), susdsPortal, _susdsRowIntents());
    sipaFactory.blessTable(forwardingTable);
    vm.stopPrank();

    registrationController = new RegistrationController(
      INameRegistry(address(nameRegistry)),
      sipaFactory,
      accountFactory,
      namePortal,
      IERC20OZ(address(DAI)),
      REGISTRATION_MIN,
      REGISTRATION_FEE,
      FEE_BENEFICIARY
    );
    _setController(address(registrationController));

    daiSubsidy = _subsidyFor(address(portal));
    susdsSubsidy = _subsidyFor(address(susdsPortal));
    vm.fee(PRICED_BASEFEE);
    vm.txGasPrice(PRICED_BASEFEE);

    payer = makeAddr("payer");
    gasRelayer = makeAddr("gasRowsRelayer");
    holderRelayer = makeAddr("gasRowsHolderRelayer");
    usdcImplementation = address(uint160(uint256(vm.load(address(USDC), USDC_IMPLEMENTATION_SLOT))));
    susdsImplementation = address(uint160(uint256(vm.load(address(SUSDS), ERC1967_IMPLEMENTATION_SLOT))));
    accountImplementation = OxideAccountFactory(address(accountFactory)).implementation();

    _warmInbox(8);
    _warmRegistration();

    _stageRows();

    assertEq(DAI.balanceOf(gasRelayer), 0, "the relayer must hold no DAI");
    assertEq(SUSDS.balanceOf(gasRelayer), 0, "the relayer must hold no sUSDS");
    deal(address(DAI), holderRelayer, 1);
    deal(address(SUSDS), holderRelayer, 1);
  }

  function _stageRows() internal virtual;

  function _stageRow(string memory _row) internal {
    string memory json = vm.readFile(GAS_ROWS);
    string memory key = string.concat(".rows.", _row);
    string memory intent = vm.parseJsonString(json, string.concat(key, ".intent"));
    string memory input = vm.parseJsonString(json, string.concat(key, ".input"));
    bool deployed = vm.parseJsonBool(json, string.concat(key, ".deployed"));
    bool idleDai = vm.parseJsonBool(json, string.concat(key, ".idleDai"));
    IERC20 token = _tokenNamed(input);
    uint256 amount = address(token) == address(USDC) || address(token) == address(USDT) ? STABLE_DEPOSIT : DEPOSIT;
    string memory idle = idleDai ? ".idle" : "";
    if (keccak256(bytes(intent)) == keccak256("deposit")) {
      bytes32 salt = bytes32(bytes(string.concat(input, deployed ? ".first" : ".resweep", idle)));
      DepositSubsidy subsidy = _subsidyNamed(vm.parseJsonString(json, string.concat(key, ".row")));
      _stageDeposit(_row, salt, subsidy, token, amount, !deployed, idleDai);
    } else if (keccak256(bytes(intent)) == keccak256("registration")) {
      string memory salt = string.concat("gasRows.reg.", input, deployed ? ".first" : "", idle);
      _stageRegistration(_row, salt, token, amount, !deployed, idleDai);
    } else {
      revert("the fixture has no staging for this intent");
    }
  }

  function _tokenNamed(string memory _name) internal pure returns (IERC20) {
    bytes32 name = keccak256(bytes(_name));
    if (name == keccak256("dai")) return DAI;
    if (name == keccak256("usdc")) return USDC;
    if (name == keccak256("usdt")) return USDT;
    require(name == keccak256("susds"), "the fixture has no token of this name");
    return SUSDS;
  }

  function _subsidyNamed(string memory _row) internal view returns (DepositSubsidy) {
    bytes32 name = keccak256(bytes(_row));
    if (name == keccak256("dai")) return daiSubsidy;
    require(name == keccak256("susds"), "the fixture has no subsidy for this forwarding-table row");
    return susdsSubsidy;
  }

  function _checkRow(string memory _row) internal {
    Relay memory relay = relays[_row];
    _openNextInboxBucket();
    uint256 snapshot = vm.snapshotState();
    _assertHolderPricedAtMostTheTransactionGas(_row, relay);
    vm.revertToState(snapshot);

    _coolAll(relay.sipa);
    vm.prank(gasRelayer, gasRelayer);
    (bool ok, bytes memory ret) = address(operationExecutor).call(relay.outer);
    require(ok, "relay reverted");

    Measurement memory m;
    m.txGas = RelayerTransaction.lastIsolatedTxGas();
    m.row = _row;
    m.subsidy = relay.subsidy;
    m.input = relay.input;
    m.deployed = relay.deployed;
    m.outer = relay.outer;
    m.intent = sipaFactory.sipaIntentOf(relay.sipa);
    m.priced = _recoverPricedGas(relay.subsidy, m.intent, abi.decode(ret, (uint256)));
    _assertGasRow(m);
  }

  function _assertHolderPricedAtMostTheTransactionGas(string memory _row, Relay memory _relay) internal {
    _coolAll(_relay.sipa);
    vm.prank(holderRelayer, holderRelayer);
    (bool ok, bytes memory ret) = address(operationExecutor).call(_relay.outer);
    require(ok, "relay reverted");
    uint256 txGas = RelayerTransaction.lastIsolatedTxGas();
    uint256 priced =
      _recoverPricedGas(_relay.subsidy, sipaFactory.sipaIntentOf(_relay.sipa), abi.decode(ret, (uint256)));
    console2.log("  holder: tx gas", txGas, "priced", priced);
    assertLe(
      priced, txGas, string.concat(_row, ": the subsidy priced more gas than a relayer that holds the token used")
    );
  }

  function _recoverPricedGas(DepositSubsidy _subsidy, Intent _intent, uint256 _payout)
    internal
    view
    returns (uint256 priced)
  {
    (,,, uint128 tip) = forwardingTable.rowFor(address(_subsidy.TOKEN()), _intent);
    (uint128 profit,,) = _subsidy.$depositConfig();
    uint256 gasCost = _payout - Math.min(profit, tip);
    uint256 tokenWeiPerEth = _chainlinkTokenWeiPerEth();
    priced = Math.mulDiv(gasCost, 1e18, PRICED_BASEFEE * tokenWeiPerEth, Math.Rounding.Ceil);
    assertEq(
      Math.mulDiv(priced * PRICED_BASEFEE, tokenWeiPerEth, 1e18),
      gasCost,
      "the payout is not the price of whole gas units: a cap or the pot bound the subsidy"
    );
  }

  function _assertGasRow(Measurement memory m) internal {
    string memory json = vm.readFile(GAS_ROWS);
    string memory row = string.concat(".rows.", m.row);
    uint256 padding = vm.parseJsonUint(json, ".relayerCalldataPadding");
    uint256 coverGas = vm.parseJsonUint(json, string.concat(row, ".coverGas"));
    uint256 unpricedGas = vm.parseJsonUint(json, string.concat(row, ".unpricedGas"));

    assertLe(m.priced, m.txGas, string.concat(m.row, ": the subsidy priced more gas than the transaction used"));
    uint256 chainCover = m.txGas + padding;
    uint256 chainUnpriced = chainCover - m.priced;
    uint256 floorGas = _calldataFloorGas(m.outer);

    console2.log(m.row);
    console2.log("  tx gas", m.txGas, "priced", m.priced);
    console2.log("  chain cover", chainCover, "chain unpriced", chainUnpriced);
    console2.log("  ceiling", _ceiling(m.subsidy, m.intent, m.input, m.deployed));
    console2.log("  calldata floor", floorGas);

    assertEq(
      vm.parseJsonString(json, string.concat(row, ".row")),
      _tokenName(address(m.subsidy.TOKEN())),
      string.concat(m.row, ": the gas row names another forwarding-table row")
    );
    assertEq(
      vm.parseJsonString(json, string.concat(row, ".intent")),
      m.intent == Intents.DEPOSIT ? "deposit" : "registration",
      string.concat(m.row, ": the gas row names another intent")
    );
    assertEq(
      vm.parseJsonBool(json, string.concat(row, ".deployed")),
      m.deployed,
      string.concat(m.row, ": the gas row says the opposite about the SIPA deployment")
    );

    assertLe(chainCover, coverGas, string.concat(m.row, ": coverGas sits under the relay on chain"));
    assertLe(
      coverGas, (chainCover * 110) / 100, string.concat(m.row, ": coverGas is more than 10% above the relay on chain")
    );
    assertLe(
      chainUnpriced,
      unpricedGas,
      string.concat(m.row, ": unpricedGas sits under the gas that the subsidy does not price")
    );
    assertLe(
      unpricedGas,
      chainUnpriced + 500,
      string.concat(m.row, ": unpricedGas is more than 500 gas above the gas that the subsidy does not price")
    );
    assertLe(floorGas, m.txGas, string.concat(m.row, ": the EIP-7623 calldata floor sets the transaction gas"));
  }

  function _maxRefundEstimate(DepositSubsidy _subsidy, address _input) internal view returns (uint256 refund) {
    uint256 cleared = _subsidy.CLEARED_SLOT_REFUND();
    uint256 restoredZero = _subsidy.RESTORED_ZERO_SLOT_REFUND();
    bool swapped = _input != address(_subsidy.TOKEN());
    refund = (swapped ? restoredZero : cleared) + restoredZero + restoredZero;
    if (swapped) {
      refund += cleared + restoredZero + restoredZero;
    }
  }

  function _ceiling(DepositSubsidy _subsidy, Intent _intent, address _input, bool _deployed)
    internal
    view
    returns (uint256 ceiling)
  {
    ceiling = _subsidy.$sweepGasCeilings(_intent);
    if (_deployed) {
      ceiling += _subsidy.SWEEP_GAS_DEPLOY_ALLOWANCE();
    }
    if (_input == address(USDC)) {
      ceiling += _subsidy.SWEEP_GAS_SWAP_USDC_HOP();
    } else if (_input == address(USDT)) {
      ceiling += _subsidy.SWEEP_GAS_SWAP_USDT_HOP();
    }
    ceiling += _subsidy.FRESH_BALANCE_GAS();
  }

  function _calldataFloorGas(bytes memory _data) internal pure returns (uint256) {
    uint256 tokens;
    for (uint256 i = 0; i < _data.length; i++) {
      tokens += _data[i] == 0 ? 1 : 4;
    }
    return RelayerTransaction.TX_INTRINSIC_GAS + 10 * tokens;
  }

  function _tokenName(address _token) internal pure returns (string memory) {
    if (_token == address(DAI)) return "dai";
    if (_token == address(USDC)) return "usdc";
    if (_token == address(USDT)) return "usdt";
    require(_token == address(SUSDS), "no gas row names this token");
    return "susds";
  }

  function _subsidyCd(
    address _sipa,
    Intent _intent,
    bytes32 _recovery,
    IERC20 _input,
    bytes memory _intentData,
    bytes memory _proofs
  ) internal view returns (bytes memory) {
    if (_sipa.code.length > 0) {
      return abi.encodeCall(
        DepositSubsidy.sweepForSubsidy,
        (ISIPA(_sipa), address(_input), address(operationExecutor), _intentData, _proofs)
      );
    }
    return abi.encodeCall(
      DepositSubsidy.deployAndSweepForSubsidy,
      (forwardingTable, _intent, _recovery, true, address(_input), address(operationExecutor), _intentData, _proofs)
    );
  }

  function _subsidyFor(address _portal) internal returns (DepositSubsidy subsidy) {
    subsidy = new DepositSubsidy(
      OWNER,
      _portal,
      IOperationExecutor(address(operationExecutor)),
      CHAINLINK_ETH_USD,
      sipaFactory,
      new DepositSubsidy.SweepGasCeiling[](0)
    );
    _applySeedCeilings(subsidy);
    deal(address(subsidy.TOKEN()), address(subsidy), 1_000_000 ether);
    vm.prank(OWNER);
    subsidy.setDepositConfig(PRICED_MIN_PROFIT, type(uint128).max, 0);
  }

  function _seed(string memory _path) internal view returns (string memory) {
    return vm.readFile(string.concat(SEEDS, _path));
  }

  function _applySeedCeilings(DepositSubsidy _subsidy) internal {
    string memory json = _seed("name-cores/nc-v6.json");
    vm.startPrank(OWNER);
    _subsidy.setSweepGasCeiling(Intents.DEPOSIT, vm.parseJsonUint(json, ".deployment.sweepGasCeilings.deposit"));
    _subsidy.setSweepGasCeiling(
      Intents.REGISTRATION, vm.parseJsonUint(json, ".deployment.sweepGasCeilings.registration")
    );
    _subsidy.setSweepGasCeiling(Intents.ADD_PASSKEY, vm.parseJsonUint(json, ".deployment.sweepGasCeilings.add_passkey"));
    vm.stopPrank();
  }

  function _daiRowIntents() internal pure returns (IForwardingTable.IntentFees[] memory intents) {
    intents = new IForwardingTable.IntentFees[](2);
    intents[0] = IForwardingTable.IntentFees({
      intent: Intents.DEPOSIT, beneficiaryFee: DAI_DEPOSIT_BENEFICIARY_FEE, sweepTip: DAI_DEPOSIT_SWEEP_TIP
    });
    intents[1] = IForwardingTable.IntentFees({
      intent: Intents.REGISTRATION, beneficiaryFee: 0, sweepTip: DAI_REGISTRATION_SWEEP_TIP
    });
  }

  function _susdsRowIntents() internal pure returns (IForwardingTable.IntentFees[] memory intents) {
    intents = new IForwardingTable.IntentFees[](1);
    intents[0] =
      IForwardingTable.IntentFees({intent: Intents.DEPOSIT, beneficiaryFee: 0, sweepTip: SUSDS_DEPOSIT_SWEEP_TIP});
  }

  function _stageDeposit(
    string memory _row,
    bytes32 _salt,
    DepositSubsidy _subsidy,
    IERC20 _input,
    uint256 _amount,
    bool _swept,
    bool _idleDai
  ) internal {
    bytes memory intentData = _depositIntent(_salt);
    address sipa = _predictDepositSIPA(intentData);
    if (_swept) {
      _depositSIPA(intentData);
      deal(address(_subsidy.TOKEN()), sipa, DEPOSIT);
      DepositSIPA(sipa).sweep(address(_subsidy.TOKEN()), payer, intentData, "");
    }
    deal(address(_input), sipa, _amount);
    _stageIdleDai(sipa, _idleDai);
    _stageRelay(
      _row,
      _subsidy,
      _input,
      sipa,
      _subsidyCd(sipa, Intents.DEPOSIT, _recoveryCommitment("recovery"), _input, intentData, "")
    );
    relays[_row].intent = Intents.DEPOSIT;
  }

  function _stageRegistration(
    string memory _row,
    string memory _salt,
    IERC20 _input,
    uint256 _amount,
    bool _predeployed,
    bool _idleDai
  ) internal {
    (,, bytes memory rd) = _registration(_salt);
    address sipa = _predeployed ? address(_deployRegistrationSIPA(rd)) : _predictRegistrationSIPA(rd);
    deal(address(_input), sipa, _amount);
    _stageIdleDai(sipa, _idleDai);
    _stageRelay(_row, daiSubsidy, _input, sipa, _registrationCd(sipa, _input, _salt));
    relays[_row].intent = Intents.REGISTRATION;
  }

  function _stageIdleDai(address _sipa, bool _idleDai) internal {
    if (_idleDai) {
      deal(address(DAI), _sipa, 1);
    }
  }

  function _registrationCd(address _sipa, IERC20 _input, string memory _salt) internal returns (bytes memory) {
    (uint256 key, bytes32 nameHash, bytes memory rd) = _registration(_salt);
    return _subsidyCd(_sipa, Intents.REGISTRATION, regRecovery, _input, rd, _proofsFor(key, rd, nameHash));
  }

  function _stageRelay(string memory _row, DepositSubsidy _subsidy, IERC20 _input, address _sipa, bytes memory _inner)
    internal
  {
    IERC20OZ payoutToken = IERC20OZ(address(_subsidy.TOKEN()));
    relays[_row] = Relay({
      subsidy: _subsidy,
      intent: Intents.NONE,
      input: address(_input),
      sipa: _sipa,
      deployed: _sipa.code.length == 0,
      inner: _inner,
      outer: abi.encodeCall(OperationExecutor.execute, (address(_subsidy), _inner, payoutToken, 0, 0, 0))
    });
  }

  function _warmRegistration() internal {
    (uint256 key, bytes32 nameHash, bytes memory rd) = _registration("gasRows.reg.warmup");
    SIPABase sipa = _deployRegistrationSIPA(rd);
    deal(address(DAI), address(sipa), DEPOSIT);
    sipa.sweep(address(DAI), payer, rd, _proofsFor(key, rd, nameHash));
  }

  function _registration(string memory _salt) internal returns (uint256 key, bytes32 nameHash, bytes memory rd) {
    (, key) = makeAddrAndKey(_salt);
    nameHash = keccak256(bytes(_salt));
    rd = _regDataFor(nameHash, _ownerOf(key), NAME_PORTAL_RECIPIENT);
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
    bytes memory intentData = _depositIntent("inboxWarm");
    DepositSIPA s = _depositSIPA(intentData);
    for (uint256 i = 0; i < _n; i++) {
      deal(address(DAI), address(s), DEPOSIT);
      s.sweep(address(DAI), payer, intentData, "");
    }
  }

  function _coolAll(address _sipa) internal {
    address[33] memory a = [
      _sipa,
      address(sipaFactory),
      address(depositSIPAImplementation),
      address(registrationSIPAImplementation),
      address(portal),
      address(susdsPortal),
      address(forwardingTable),
      address(wiredInbox),
      address(rollup),
      address(registry),
      address(DAI),
      address(SUSDS),
      susdsImplementation,
      address(daiSubsidy),
      address(susdsSubsidy),
      address(CHAINLINK_ETH_USD),
      chainlinkAggregator,
      address(operationExecutor),
      address(USDC),
      usdcImplementation,
      address(USDT),
      address(THREE_POOL),
      address(nameRegistry),
      address(metadataRegistry),
      address(namePortal),
      address(registrationController),
      address(accountFactory),
      accountImplementation,
      address(entryPoint),
      TABLE_BENEFICIARY,
      FEE_BENEFICIARY,
      gasRelayer,
      holderRelayer
    ];
    for (uint256 i = 0; i < a.length; i++) {
      VmCooling(address(vm)).cool(a[i]);
    }
  }
}
