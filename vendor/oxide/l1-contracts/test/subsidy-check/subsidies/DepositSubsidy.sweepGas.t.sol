// SPDX-License-Identifier: Apache-2.0
pragma solidity >=0.8.27;
import {SweepGasCeilings} from "@test/helpers/SweepGasCeilings.sol";
import {console2} from "forge-std/console2.sol";

import {DepositSIPA} from "@periphery/DepositSIPA.sol";
import {DepositSubsidy} from "@periphery/DepositSubsidy.sol";
import {IOperationExecutor} from "@periphery/interfaces/IOperationExecutor.sol";
import {SIPABase} from "@periphery/SIPABase.sol";
import {AggregatorV3Interface} from "@periphery/interfaces/AggregatorV3Interface.sol";
import {ISIPA} from "@periphery/interfaces/ISIPA.sol";
import {OxideAccount} from "@periphery/OxideAccount.sol";

import {SweepGasFixture} from "@test/periphery/SweepGasFixture.sol";
import {RelayerTransaction} from "@test/periphery/RelayerTransaction.sol";
import {MockV3Aggregator} from "@test/mocks/MockV3Aggregator.sol";
import {DEPOSIT_SWEEP_TIP, REGISTRATION_SWEEP_TIP} from "@test/helpers/ForwardingTableFixture.sol";
import {Intents} from "@periphery/Intent.sol";

contract DepositSubsidySweepGasTest is SweepGasFixture {
  uint256 internal constant DEPOSIT = 100 ether;

  DepositSubsidy internal sm;

  DepositSIPA internal warmSipa;
  SIPABase internal regWarmupSipa;
  SIPABase internal regCheapestSipa;

  bytes internal rdWarmup;
  bytes internal rdCheapest;
  uint256 internal kWarmup;
  uint256 internal kCheapest;

  function setUp() public virtual override {
    super.setUp();
    MockV3Aggregator feed = new MockV3Aggregator(8, PRICED_FEED_ANSWER);
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

    warmSipa = _depositSIPA(_depositIntent("warm"));
    underlying.mint(address(warmSipa), DEPOSIT);

    address owner;
    address bootstrapAddr;
    (, kWarmup) = makeAddrAndKey("gasWarmup");
    rdWarmup = _regDataFor(keccak256("gas.warmup"), _ownerOf(kWarmup), NAME_PORTAL_RECIPIENT);
    regWarmupSipa = _deployAndFund(rdWarmup, DEPOSIT);

    (bootstrapAddr, kCheapest) = makeAddrAndKey("gasCheapest");
    owner = _ownerOf(kCheapest);
    accountFactory.deploy(bootstrapAddr);
    vm.prank(address(entryPoint));
    OxideAccount(payable(owner)).addAuthKey(r1Key, "");
    rdCheapest = _regDataFor(keccak256("gas.cheapest"), owner, bytes32(0));
    regCheapestSipa = _deployAndFund(rdCheapest, DEPOSIT);
  }

  function test_GivenAWarmResweepThroughTheDeployEntry_ThenItDrawsNoDeployAllowance() external {
    _warmInbox(8);
    bytes memory cd = _deployCd(_depositIntent("warm"));
    _submit(cd);

    uint256 dearestPriced = 0;
    for (uint256 i = 0; i < 8; i++) {
      underlying.mint(address(warmSipa), DEPOSIT);
      uint256 priced = _pricedGas(_submit(cd), DEPOSIT_SWEEP_TIP);
      if (priced > dearestPriced) dearestPriced = priced;
    }

    console2.log("deposit re-sweep through the deploy entry, priced at most", dearestPriced);
    assertLt(
      dearestPriced,
      sm.$sweepGasCeilings(Intents.DEPOSIT),
      "a warm re-sweep through the deploy entry draws the ceiling payout: the cap prices it, not the meter"
    );
  }

  function test_GivenTheCheapestRegistration_ThenTheMeterBindsRatherThanTheCeiling() external {
    _warmInbox(8);
    _submit(_cd(address(regWarmupSipa), rdWarmup, _proofsFor(kWarmup, rdWarmup, keccak256("gas.warmup"))));

    bytes memory cd = _cd(
      address(regCheapestSipa),
      rdCheapest,
      _proofsWithConsent(_r1ConsentSig(0, r1PrivateKey, rdCheapest), kCheapest, rdCheapest, keccak256("gas.cheapest"))
    );
    uint256 fee = REGISTRATION_SWEEP_TIP;
    uint256 priced = _pricedGas(_submit(cd), fee);

    console2.log("registration, priced", priced, "ceiling", sm.$sweepGasCeilings(Intents.REGISTRATION));
    assertLt(
      priced,
      sm.$sweepGasCeilings(Intents.REGISTRATION),
      "the cheapest registration draws the ceiling payout: the cap prices it, not the meter"
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

  function _deployCd(bytes memory _intentData) internal view returns (bytes memory) {
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
        ""
      )
    );
  }

  function _cd(address _sipa, bytes memory _intentData, bytes memory _proofs) internal view returns (bytes memory) {
    return abi.encodeCall(
      DepositSubsidy.sweepForSubsidy,
      (ISIPA(_sipa), address(underlying), address(operationExecutor), _intentData, _proofs)
    );
  }

  function _submit(bytes memory _callData) internal returns (uint256 quote) {
    (quote,) = RelayerTransaction.send(relayer, sm, _callData);
  }

  function _warmInbox(uint256 _n) internal {
    DepositSIPA s = _depositSIPA(_depositIntent("inboxWarm"));
    for (uint256 i = 0; i < _n; i++) {
      underlying.mint(address(s), DEPOSIT);
      vm.prank(relayer);
      s.sweep(address(underlying), relayer, _depositIntent("inboxWarm"), "");
    }
  }
}
