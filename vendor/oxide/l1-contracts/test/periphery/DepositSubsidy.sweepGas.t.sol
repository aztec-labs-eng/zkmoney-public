// SPDX-License-Identifier: Apache-2.0
pragma solidity >=0.8.27;
import {Vm} from "forge-std/Vm.sol";
import {console2} from "forge-std/console2.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {DepositSIPA, DEPOSIT_FEE} from "@periphery/DepositSIPA.sol";
import {DepositSubsidy} from "@periphery/DepositSubsidy.sol";
import {SIPABase} from "@periphery/SIPABase.sol";
import {AggregatorV3Interface} from "@periphery/interfaces/AggregatorV3Interface.sol";
import {ISIPA} from "@periphery/interfaces/ISIPA.sol";
import {DomainAuth} from "@periphery/interfaces/INameRegistry.sol";
import {AccountMetadataRegistry} from "@periphery/AccountMetadataRegistry.sol";
import {OxideAccount} from "@periphery/OxideAccount.sol";
import {OxideAccountFactory} from "@periphery/OxideAccountFactory.sol";
import {OperationExecutor} from "@periphery/OperationExecutor.sol";

import {SweepGasFixture} from "@test/periphery/SweepGasFixture.sol";
import {MockV3Aggregator} from "@test/mocks/MockV3Aggregator.sol";

interface VmCool {
  function cool(address) external;
}

contract BatchSweeper {
  function sweepAll(address _depositSubsidy, bytes[] calldata _calls)
    external
    returns (uint256[] memory quotes, uint256[] memory callGas)
  {
    quotes = new uint256[](_calls.length);
    callGas = new uint256[](_calls.length);
    for (uint256 i = 0; i < _calls.length; i++) {
      uint256 before = gasleft();
      (bool ok, bytes memory ret) = _depositSubsidy.call(_calls[i]);
      callGas[i] = before - gasleft();
      require(ok, "batched sweep reverted");
      quotes[i] = abi.decode(ret, (uint256));
    }
  }
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
    sm.setDepositConfig(PRICED_MIN_PROFIT, type(uint128).max, PRICED_MIN_PROFIT, 0, 0);
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

  function test_GivenTheCheapestDepositDeployAndSweep_ThenTheMeterBindsRatherThanTheCeiling() external {
    _warmInbox(8);
    bytes memory warmup = _depositIntent("deployWarmup");
    underlying.mint(_predictDepositSIPA(warmup), DEPOSIT);
    _submit(_deployCd(warmup));

    uint256 cheapest = type(uint256).max;
    uint256 dearestPriced = 0;
    for (uint256 i = 0; i < 8; i++) {
      bytes memory intent = _depositIntent(keccak256(abi.encode("deploy", i)));
      address sipa = _predictDepositSIPA(intent);
      underlying.mint(sipa, DEPOSIT);
      bytes memory cd = _deployCd(intent);
      uint256 priced = _pricedGas(_submit(cd), DEPOSIT_FEE);
      uint256 cost = _lastCallCost(cd);
      require(sipa.code.length > 0, "the deploy path must have deployed the SIPA");
      assertLt(priced, cost, "a deploy and sweep is paid more than it costs: the deploy farm is open");
      if (cost < cheapest) cheapest = cost;
      if (priced > dearestPriced) dearestPriced = priced;
    }

    uint256 ceiling = sm.SWEEP_GAS_DEPOSIT_CEILING() + sm.SWEEP_GAS_DEPLOY_ALLOWANCE();
    console2.log("deposit deploy and sweep, cheapest achievable (chain)", cheapest + HARNESS_TO_CHAIN);
    console2.log("deposit deploy and sweep, priced at most", dearestPriced, "ceiling", ceiling);
    assertLt(
      dearestPriced, ceiling, "a warm deploy and sweep draws the ceiling payout: the cap prices it, not the meter"
    );
  }

  function test_GivenAWarmResweepThroughTheDeployEntry_ThenItDrawsNoDeployAllowance() external {
    _warmInbox(8);
    bytes memory cd = _deployCd(_depositIntent("warm"));
    _submit(cd);

    uint256 dearestPriced = 0;
    for (uint256 i = 0; i < 8; i++) {
      underlying.mint(address(warmSipa), DEPOSIT);
      uint256 priced = _pricedGas(_submit(cd), DEPOSIT_FEE);
      assertLt(priced, _lastCallCost(cd), "a warm re-sweep is paid more than it costs: the deposit farm is open");
      if (priced > dearestPriced) dearestPriced = priced;
    }

    console2.log("deposit re-sweep through the deploy entry, priced at most", dearestPriced);
    assertLt(
      dearestPriced,
      sm.SWEEP_GAS_DEPOSIT_CEILING(),
      "a warm re-sweep through the deploy entry draws the ceiling payout: the cap prices it, not the meter"
    );
  }

  function test_GivenATypicalDepositDeployAndSweep_ThenTheCeilingWithTheDeployAllowanceSitsAtOrAboveIt() external {
    _warmInbox(8);
    bytes memory intent = _depositIntent("freshDeploy");
    address sipa = _predictDepositSIPA(intent);
    underlying.mint(sipa, DEPOSIT);
    bytes memory cd = _deployCd(intent);
    _coolAll(sipa);
    _submit(cd);
    require(sipa.code.length > 0, "the deploy path must have deployed the SIPA");
    uint256 typicalCost = _lastCallChainCost(cd);
    uint256 ceiling = sm.SWEEP_GAS_DEPOSIT_CEILING() + sm.SWEEP_GAS_DEPLOY_ALLOWANCE();

    console2.log("deposit deploy and sweep, typical first sweep (chain)", typicalCost);
    console2.log("deposit deploy and sweep, ceiling", ceiling);
    assertGe(
      ceiling,
      typicalCost,
      "SWEEP_GAS_DEPLOY_ALLOWANCE sits under a typical deploy and sweep: an honest first sweep is clipped"
    );
    assertLe(
      ceiling,
      (typicalCost * 110) / 100,
      "SWEEP_GAS_DEPLOY_ALLOWANCE has drifted well above the typical deploy and sweep"
    );
  }

  function test_LogTheUnmeteredOverheadOfADepositSweep() external {
    _warmInbox(8);
    BatchSweeper batcher = new BatchSweeper();
    uint256 n = 6;
    bytes[] memory calls = new bytes[](n);
    for (uint256 i = 0; i < n; i++) {
      bytes memory intent = _depositIntent(keccak256(abi.encode("batch", i)));
      DepositSIPA sipa = _depositSIPA(intent);
      underlying.mint(address(sipa), DEPOSIT);
      calls[i] = _cd(address(sipa), intent, "");
    }
    vm.prank(relayer);
    (uint256[] memory quotes, uint256[] memory callGas) = batcher.sweepAll(address(sm), calls);
    uint256 cheapestBatched = type(uint256).max;
    for (uint256 i = 1; i < n; i++) {
      uint256 overhead = _calldataGas(calls[i]) + callGas[i] - _meteredGas(_pricedGas(quotes[i], DEPOSIT_FEE));
      if (overhead < cheapestBatched) cheapestBatched = overhead;
    }
    console2.log("deposit, per-call overhead of a 2nd+ batched sweep, without the 21000", cheapestBatched);

    bytes memory directIntent = _depositIntent("directOverhead");
    DepositSIPA direct = _depositSIPA(directIntent);
    underlying.mint(address(direct), DEPOSIT);
    bytes memory directCd = _cd(address(direct), directIntent, "");
    _coolAll(address(direct));
    uint256 directQuote = _submit(directCd);
    console2.log(
      "deposit, direct single-call overhead, with the 21000",
      21_000 + _unmeteredCallCost(directCd, _pricedGas(directQuote, DEPOSIT_FEE))
    );

    OperationExecutor executor = new OperationExecutor();
    bytes memory executorIntent = _depositIntent("executorOverhead");
    DepositSIPA viaExecutor = _depositSIPA(executorIntent);
    underlying.mint(address(viaExecutor), DEPOSIT);
    bytes memory executeCd = abi.encodeCall(
      OperationExecutor.execute,
      (
        address(sm),
        abi.encodeCall(
          DepositSubsidy.sweepForSubsidy,
          (ISIPA(address(viaExecutor)), address(underlying), address(executor), executorIntent, "")
        ),
        IERC20(address(underlying)),
        0
      )
    );
    _coolAll(address(viaExecutor));
    VmCool(address(vm)).cool(address(executor));
    vm.prank(relayer);
    (bool ok, bytes memory ret) = address(executor).call(executeCd);
    require(ok, "execute reverted");
    uint256 executorQuote = abi.decode(ret, (uint256)) - DEPOSIT_FEE;
    console2.log(
      "deposit, OperationExecutor.execute overhead, with the 21000",
      21_000 + _unmeteredCallCost(executeCd, _pricedGas(executorQuote, DEPOSIT_FEE))
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

  function _meteredGas(uint256 _priced) internal view returns (uint256) {
    require(_priced < sm.SWEEP_GAS_DEPOSIT_CEILING(), "the ceiling clipped the sweep: the meter cannot be read back");
    return _priced < 4 * sm.REFUND_ALLOWANCE() ? _priced + _priced / 4 : _priced + sm.REFUND_ALLOWANCE();
  }

  function _unmeteredCallCost(bytes memory _callData, uint256 _priced) internal returns (uint256) {
    Vm.Gas memory g = vm.lastCallGas();
    return _calldataGas(_callData) + uint256(g.gasTotalUsed) - _meteredGas(_priced);
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

  function _predictDepositSIPA(bytes memory _intent) internal view returns (address) {
    return sipaFactory.predictSIPA(
      address(depositSIPAImplementation), keccak256(_intent), _recoveryCommitment("recovery"), ROLLUP_VERSION, true
    );
  }

  function _deployCd(bytes memory _intentData) internal view returns (bytes memory) {
    return abi.encodeCall(
      DepositSubsidy.deployAndSweepForSubsidy,
      (SIPABase.Intent.Deposit, _recoveryCommitment("recovery"), true, address(underlying), relayer, _intentData, "")
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
