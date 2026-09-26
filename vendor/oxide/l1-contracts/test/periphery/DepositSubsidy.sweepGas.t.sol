// SPDX-License-Identifier: Apache-2.0
pragma solidity >=0.8.27;
import {console2} from "forge-std/console2.sol";

import {DepositSIPA, DEPOSIT_FEE} from "@periphery/DepositSIPA.sol";
import {DepositSubsidy} from "@periphery/DepositSubsidy.sol";
import {SIPABase} from "@periphery/SIPABase.sol";
import {AggregatorV3Interface} from "@periphery/interfaces/AggregatorV3Interface.sol";
import {ISIPA} from "@periphery/interfaces/ISIPA.sol";
import {DomainAuth} from "@periphery/interfaces/INameRegistry.sol";
import {AccountMetadataRegistry} from "@periphery/AccountMetadataRegistry.sol";
import {OxideAccount} from "@periphery/OxideAccount.sol";
import {OxideAccountFactory} from "@periphery/OxideAccountFactory.sol";

import {SweepGasFixture} from "@test/periphery/SweepGasFixture.sol";
import {MockV3Aggregator} from "@test/mocks/MockV3Aggregator.sol";

interface VmCool {
  function cool(address) external;
}

contract DepositSubsidySweepGasTest is SweepGasFixture {
  uint256 internal constant DEPOSIT = 100 ether;

  DepositSubsidy internal sm;

  DepositSIPA internal warmSipa;
  SIPABase internal regWarmupSipa;
  SIPABase internal regTypicalSipa;
  SIPABase internal regCheapestSipa;

  bytes internal rdWarmup;
  bytes internal rdTypical;
  bytes internal rdCheapest;
  uint256 internal kWarmup;
  uint256 internal kTypical;
  uint256 internal kCheapest;

  function setUp() public virtual override {
    super.setUp();
    MockV3Aggregator feed = new MockV3Aggregator(8, PRICED_FEED_ANSWER);
    sm = new DepositSubsidy(OWNER, address(portal), AggregatorV3Interface(address(feed)), sipaFactory);
    underlying.mint(address(sm), 1_000_000 ether);
    vm.prank(OWNER);
    sm.setDepositConfig(PRICED_MIN_PROFIT, type(uint128).max, PRICED_MIN_PROFIT);
    vm.fee(PRICED_BASEFEE);
    vm.txGasPrice(PRICED_BASEFEE);

    warmSipa = _depositSIPA(_depositIntent("warm"));
    underlying.mint(address(warmSipa), DEPOSIT);

    address owner;
    address bootstrapAddr;
    (, kWarmup) = makeAddrAndKey("gasWarmup");
    rdWarmup = _regDataFor(keccak256("gas.warmup"), _ownerOf(kWarmup), NAME_PORTAL_RECIPIENT);
    regWarmupSipa = _deployAndFund(rdWarmup, DEPOSIT);

    (, kTypical) = makeAddrAndKey("gasTypical");
    rdTypical = _regDataFor(keccak256("gas.typical"), _ownerOf(kTypical), NAME_PORTAL_RECIPIENT);
    regTypicalSipa = _deployAndFund(rdTypical, DEPOSIT);

    (bootstrapAddr, kCheapest) = makeAddrAndKey("gasCheapest");
    owner = _ownerOf(kCheapest);
    accountFactory.deploy(bootstrapAddr);
    vm.prank(address(entryPoint));
    OxideAccount(payable(owner)).addAuthKey(r1Key, "");
    rdCheapest = _regDataFor(keccak256("gas.cheapest"), owner, bytes32(0));
    regCheapestSipa = _deployAndFund(rdCheapest, DEPOSIT);
  }

  function test_GivenTheCheapestDepositSweep_ThenTheMeterBindsRatherThanTheCeiling() external {
    _warmInbox(8);
    bytes memory cd = _cd(address(warmSipa), _depositIntent("warm"), "");
    _submit(cd);

    uint256 cheapest = type(uint256).max;
    uint256 dearestPriced = 0;
    for (uint256 i = 0; i < 8; i++) {
      underlying.mint(address(warmSipa), DEPOSIT);
      uint256 priced = _pricedGas(_submit(cd), DEPOSIT_FEE);
      uint256 cost = _lastCallCost(cd);
      assertLt(priced, cost, "a warm re-sweep is paid more than it costs: the deposit farm is open");
      if (cost < cheapest) cheapest = cost;
      if (priced > dearestPriced) dearestPriced = priced;
    }

    console2.log("deposit, cheapest achievable (chain)", cheapest + HARNESS_TO_CHAIN);
    console2.log("deposit, priced at most", dearestPriced, "ceiling", sm.SWEEP_GAS_DEPOSIT_CEILING());
    assertLt(
      dearestPriced,
      sm.SWEEP_GAS_DEPOSIT_CEILING(),
      "a warm re-sweep draws the ceiling payout: the cap prices it, not the meter"
    );
  }

  function test_GivenATypicalDepositSweep_ThenTheCeilingSitsAtOrAboveIt() external {
    _warmInbox(8);
    DepositSIPA fresh = _depositSIPA(_depositIntent("fresh"));
    underlying.mint(address(fresh), DEPOSIT);
    bytes memory cd = _cd(address(fresh), _depositIntent("fresh"), "");
    _coolAll(address(fresh));
    _submit(cd);
    uint256 typicalCost = _lastCallChainCost(cd);

    console2.log("deposit, typical first sweep (chain)", typicalCost);
    console2.log("deposit, ceiling", sm.SWEEP_GAS_DEPOSIT_CEILING());
    assertGe(
      sm.SWEEP_GAS_DEPOSIT_CEILING(),
      typicalCost,
      "SWEEP_GAS_DEPOSIT_CEILING sits under a typical deposit sweep: an honest first sweep is clipped"
    );
    assertLe(
      sm.SWEEP_GAS_DEPOSIT_CEILING(),
      (typicalCost * 110) / 100,
      "SWEEP_GAS_DEPOSIT_CEILING has drifted well above the typical deposit sweep"
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
    uint256 fee = registrationSIPAImplementation.DEPOSIT_FEE();
    uint256 priced = _pricedGas(_submit(cd), fee);
    uint256 cheapest = _lastCallCost(cd);

    console2.log("registration, cheapest achievable (chain)", cheapest + HARNESS_TO_CHAIN);
    console2.log("registration, priced", priced, "ceiling", sm.SWEEP_GAS_REGISTRATION_CEILING());
    assertLt(
      priced,
      sm.SWEEP_GAS_REGISTRATION_CEILING(),
      "the cheapest registration draws the ceiling payout: the cap prices it, not the meter"
    );
    assertLt(priced, cheapest, "the cheapest registration is paid more than it costs: driving one turns a profit");
  }

  function test_GivenATypicalRegistration_ThenTheCeilingSitsAtOrAboveIt() external {
    _warmInbox(8);
    _submit(_cd(address(regWarmupSipa), rdWarmup, _proofsFor(kWarmup, rdWarmup, keccak256("gas.warmup"))));

    require(_ownerOf(kTypical).code.length == 0, "the typical owner must not be deployed yet");
    bytes memory cd = _cd(address(regTypicalSipa), rdTypical, _proofsFor(kTypical, rdTypical, keccak256("gas.typical")));
    _coolAll(address(regTypicalSipa));
    _submit(cd);
    uint256 typicalCost = _lastCallChainCost(cd);

    console2.log("registration, typical (chain)", typicalCost);
    console2.log("registration, ceiling", sm.SWEEP_GAS_REGISTRATION_CEILING());
    assertGe(
      sm.SWEEP_GAS_REGISTRATION_CEILING(),
      typicalCost,
      "SWEEP_GAS_REGISTRATION_CEILING sits under a typical registration: relayers would be clipped on every one"
    );
    assertLe(
      sm.SWEEP_GAS_REGISTRATION_CEILING(),
      (typicalCost * 110) / 100,
      "SWEEP_GAS_REGISTRATION_CEILING has drifted well above the typical registration"
    );
  }

  function _depositIntent(bytes32 _salt) internal pure returns (bytes memory) {
    return abi.encode(_field(_salt));
  }

  function _depositSIPA(bytes memory _intent) internal returns (DepositSIPA) {
    return DepositSIPA(
      sipaFactory.deploySIPA(
        address(depositSIPAImplementation), keccak256(_intent), _recoveryCommitment("recovery"), ROLLUP_VERSION, true
      )
    );
  }

  function _regDataFor(bytes32 _nameHash, address _owner, bytes32 _portalRecipient)
    internal
    view
    returns (bytes memory)
  {
    bytes memory recordData = abi.encode(
      _owner,
      _nameHash,
      _record(AccountMetadataRegistry.K1Point(G_X, G_Y), _field(L2_ADDRESS), resolverOperatorAddr, ROLLUP_VERSION)
    );
    return
      abi.encode(recordData, REGISTRATION_FEE, FEE_BENEFICIARY, _field(RECIPIENT_COMMITMENT), _field(_portalRecipient));
  }

  function _proofsFor(uint256 _key, bytes memory _rd, bytes32 _nameHash) internal returns (bytes memory) {
    return _proofsWithConsent(_consentSig(_key, _rd), _key, _rd, _nameHash);
  }

  function _proofsWithConsent(bytes memory _consent, uint256 _key, bytes memory _rd, bytes32 _nameHash)
    internal
    returns (bytes memory)
  {
    return _regProofs(
      vm.addr(_key),
      _consent,
      _domainAuth(_nameHash, _ownerOf(_key), nextNonce++, block.timestamp + 1 days),
      _noTerms(),
      _r1InstallWith(_key, _ownerOf(_key), r1Key, _credentialId())
    );
  }

  function _credentialId() internal pure returns (bytes memory) {
    return abi.encodePacked(keccak256("credential-id.hi"), keccak256("credential-id.lo"));
  }

  function _cd(address _sipa, bytes memory _intentData, bytes memory _proofs) internal view returns (bytes memory) {
    return
      abi.encodeCall(DepositSubsidy.sweepForSubsidy, (ISIPA(_sipa), address(underlying), relayer, _intentData, _proofs));
  }

  function _submit(bytes memory _callData) internal returns (uint256 quote) {
    vm.prank(relayer);
    (bool ok, bytes memory ret) = address(sm).call(_callData);
    require(ok, "sweep reverted");
    quote = abi.decode(ret, (uint256));
  }

  function _warmInbox(uint256 _n) internal {
    DepositSIPA s = _depositSIPA(_depositIntent("inboxWarm"));
    for (uint256 i = 0; i < _n; i++) {
      underlying.mint(address(s), DEPOSIT);
      vm.prank(relayer);
      s.sweep(address(underlying), relayer, _depositIntent("inboxWarm"), "");
    }
  }

  function _coolAll(address _sipa) internal {
    address[18] memory a = [
      _sipa,
      address(sipaFactory),
      address(depositSIPAImplementation),
      address(registrationSIPAImplementation),
      address(portal),
      address(portal),
      address(wiredInbox),
      address(rollup),
      address(registry),
      address(underlying),
      address(sm),
      address(nameRegistry),
      address(metadataRegistry),
      address(namePortal),
      address(registrationController),
      address(accountFactory),
      address(entryPoint),
      OxideAccountFactory(address(accountFactory)).implementation()
    ];
    for (uint256 i = 0; i < a.length; i++) {
      VmCool(address(vm)).cool(a[i]);
    }
    VmCool(address(vm)).cool(relayer);
    VmCool(address(vm)).cool(FEE_BENEFICIARY);
  }
}
