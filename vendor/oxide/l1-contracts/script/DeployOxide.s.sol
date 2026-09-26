// SPDX-License-Identifier: Apache-2.0
pragma solidity >=0.8.27;

import {OxideScript} from "./OxideScript.sol";
import {console} from "forge-std/console.sol";

import {FirstProverProofSubmitter} from "@periphery/FirstProverProofSubmitter.sol";
import {FPCFunderDAI} from "@periphery/fpc_funder/FPCFunderDAI.sol";
import {FPCFunderTestnet} from "@test/mocks/FPCFunderTestnet.sol";
import {OperationExecutor} from "@periphery/OperationExecutor.sol";
import {PlainWithdrawalExecutor} from "@periphery/PlainWithdrawalExecutor.sol";
import {DepositSubsidy} from "@periphery/DepositSubsidy.sol";
import {DepositSIPA, DEPOSIT_FEE} from "@periphery/DepositSIPA.sol";
import {AggregatorV3Interface} from "@periphery/interfaces/AggregatorV3Interface.sol";
import {SIPAFactory} from "@periphery/SIPAFactory.sol";
import {INameRegistry} from "@periphery/interfaces/INameRegistry.sol";
import {RegistrationSIPA, REGISTRATION_SWEEP_FEE} from "@periphery/RegistrationSIPA.sol";
import {OxidePortal} from "@core/OxidePortal.sol";
import {IOxidePortal} from "@core/interfaces/IOxidePortal.sol";
import {CertManager} from "@core/lib/CertManager.sol";
import {NitroValidator} from "@core/lib/NitroValidator.sol";
import {ICertManager} from "@nitro-validator/ICertManager.sol";
import {INitroValidator} from "@core/lib/TEERegistrationLib.sol";

import {TestERC20} from "@aztec/mock/TestERC20.sol";

import {IERC20} from "@oz/token/ERC20/IERC20.sol";
import {IRollup} from "@aztec/core/interfaces/IRollup.sol";
import {IRegistry} from "@aztec/governance/interfaces/IRegistry.sol";
import {IVerifier} from "@aztec/core/interfaces/IVerifier.sol";

import {HonkVerifier as FrozenNotesRefundVerifier} from "@generated/FrozenNotesRefundVerifier.sol";
import {HonkVerifier as FrozenDepositRefundVerifier} from "@generated/FrozenDepositRefundVerifier.sol";
import {HonkVerifier as UnprocessedDepositRefundVerifier} from "@generated/UnprocessedDepositRefundVerifier.sol";

contract DeployOxide is OxideScript {
  function deployVersionIndependentContracts()
    external
    returns (address token, address certManager, address nitroValidator)
  {
    vm.startBroadcast();

    address owner = _envOr("OXIDE_OWNER", msg.sender);

    if (_envOr("OXIDE_DEPLOY_TOKEN", true)) {
      token = address(new TestERC20("Test", "TST", owner));
    }
    CertManager cm = new CertManager();
    NitroValidator nv = new NitroValidator(ICertManager(address(cm)));

    vm.stopBroadcast();

    certManager = address(cm);
    nitroValidator = address(nv);
  }

  struct PortalInputs {
    address owner;
    address postDeployOwner;
    IERC20 token;
    ICertManager certManager;
    INitroValidator nitroValidator;
    IRegistry registry;
    uint256 rollupVersion;
    address nameRegistry;
    address sipaFactory;
    uint256 rate;
    uint256 globalLimit;
    AggregatorV3Interface priceFeed;
    bytes32 fpcBeneficiary;
    uint256 fpcFundingCut;
  }

  function _readInputs() internal view returns (PortalInputs memory i) {
    i.owner = _envOr("OXIDE_OWNER", address(0xA11CE));
    i.postDeployOwner = _envOr("OXIDE_POST_DEPLOY_OWNER", i.owner);
    i.token = IERC20(_envOr("OXIDE_TOKEN", address(0x70CE)));
    i.certManager = ICertManager(_envOr("OXIDE_CERT_MANAGER", address(0xCE27)));
    i.nitroValidator = INitroValidator(_envOr("OXIDE_NITRO_VALIDATOR", address(0x07A1)));
    i.registry = IRegistry(_envAddress("OXIDE_REGISTRY"));
    i.rollupVersion = _envUint("OXIDE_ROLLUP_VERSION");
    i.nameRegistry = _envAddress("OXIDE_NAME_REGISTRY");
    i.sipaFactory = _envAddress("OXIDE_SIPA_FACTORY");
    i.rate = _envOr("OXIDE_RATE", uint256(50_000e18) / 86_400);
    i.globalLimit = _envOr("OXIDE_GLOBAL_LIMIT", uint256(50_000e18));
    i.priceFeed = AggregatorV3Interface(_envAddress("OXIDE_PRICE_FEED"));
    i.fpcBeneficiary = _envBytes32("OXIDE_FPC_BENEFICIARY");
    i.fpcFundingCut = _envOr("OXIDE_FPC_FUNDING_CUT", uint256(10e16));
  }

  struct Deployment {
    address portal;
    address depositSubsidy;
    address frozenNotes;
    address frozenDeposit;
    address unprocessedDeposit;
    address operationExecutor;
    address plainWithdrawalExecutor;
    address firstProverProofSubmitter;
    address fpcFunder;
    address depositSIPAImplementation;
    address registrationSIPAImplementation;
  }

  function run() external returns (Deployment memory d) {
    PortalInputs memory i = _readInputs();

    IRollup rollup = IRollup(address(i.registry.getRollup(i.rollupVersion)));

    vm.startBroadcast();

    d.operationExecutor = address(new OperationExecutor());
    d.frozenNotes = address(new FrozenNotesRefundVerifier());
    d.frozenDeposit = address(new FrozenDepositRefundVerifier());
    d.unprocessedDeposit = address(new UnprocessedDepositRefundVerifier());
    d.fpcFunder = _deployFpcFunder(i);

    d.portal = address(
      new OxidePortal(
        i.owner,
        OxidePortal.FpcFunding({funder: d.fpcFunder, cut: i.fpcFundingCut}),
        i.certManager,
        i.nitroValidator,
        i.token,
        i.registry,
        i.rollupVersion,
        OxidePortal.RefundVerifiers({
          frozenNotes: IVerifier(d.frozenNotes),
          frozenDeposit: IVerifier(d.frozenDeposit),
          unprocessedDeposit: IVerifier(d.unprocessedDeposit)
        }),
        i.rate,
        i.globalLimit
      )
    );
    d.plainWithdrawalExecutor = address(new PlainWithdrawalExecutor(d.portal));
    {
      d.depositSIPAImplementation = address(new DepositSIPA(IOxidePortal(d.portal), DEPOSIT_FEE));
      d.registrationSIPAImplementation =
        address(new RegistrationSIPA(IOxidePortal(d.portal), INameRegistry(i.nameRegistry), REGISTRATION_SWEEP_FEE));
      SIPAFactory(i.sipaFactory).bless(d.depositSIPAImplementation);
      SIPAFactory(i.sipaFactory).bless(d.registrationSIPAImplementation);
      d.firstProverProofSubmitter = address(new FirstProverProofSubmitter(rollup, IOxidePortal(d.portal)));
      DepositSubsidy depositSubsidyContract =
        new DepositSubsidy(i.owner, d.portal, i.priceFeed, SIPAFactory(i.sipaFactory));
      depositSubsidyContract.setDepositConfig(
        uint128(_envOr("OXIDE_DEPOSIT_MIN_PROFIT", uint256(0.1e18))),
        uint128(_envOr("OXIDE_DEPOSIT_MAX", uint256(12e18))),
        uint128(_envOr("OXIDE_DEPOSIT_MIN_FEE", DEPOSIT_FEE))
      );
      if (i.postDeployOwner != i.owner) {
        depositSubsidyContract.transferOwnership(i.postDeployOwner);
      }
      d.depositSubsidy = address(depositSubsidyContract);
    }

    vm.stopBroadcast();

    console.log("DepositSubsidy                   ", d.depositSubsidy);
    console.log("  owner                          ", i.postDeployOwner);
    console.log("FrozenNotesRefundVerifier        ", d.frozenNotes);
    console.log("FrozenDepositRefundVerifier      ", d.frozenDeposit);
    console.log("UnprocessedDepositRefundVerifier ", d.unprocessedDeposit);
    console.log("OperationExecutor                ", d.operationExecutor);
    console.log("PlainWithdrawalExecutor          ", d.plainWithdrawalExecutor);
    console.log("FirstProverProofSubmitter        ", d.firstProverProofSubmitter);
    console.log("FPCFunder                        ", d.fpcFunder);
    console.log("DepositSIPA implementation       ", d.depositSIPAImplementation);
    console.log("RegistrationSIPA implementation  ", d.registrationSIPAImplementation);
    console.log("OxidePortal                        ", d.portal);

    _writeManifest(d);
  }

  function _deployFpcFunder(PortalInputs memory i) internal returns (address) {
    if (block.chainid == 1) {
      return address(new FPCFunderDAI(i.registry, i.rollupVersion, i.fpcBeneficiary, i.priceFeed));
    }
    return address(new FPCFunderTestnet(i.registry, i.rollupVersion, i.fpcBeneficiary, i.token));
  }

  function _writeManifest(Deployment memory d) internal {
    string memory manifestPath = _envOr("OXIDE_MANIFEST_PATH", string("out/oxide-deploy-manifest.json"));
    string memory obj = "oxideDeployManifest";
    vm.serializeAddress(obj, "portal", d.portal);
    vm.serializeAddress(obj, "depositSubsidy", d.depositSubsidy);
    vm.serializeAddress(obj, "frozenNotes", d.frozenNotes);
    vm.serializeAddress(obj, "frozenDeposit", d.frozenDeposit);
    vm.serializeAddress(obj, "unprocessedDeposit", d.unprocessedDeposit);
    vm.serializeAddress(obj, "operationExecutor", d.operationExecutor);
    vm.serializeAddress(obj, "plainWithdrawalExecutor", d.plainWithdrawalExecutor);
    vm.serializeAddress(obj, "fpcFunder", d.fpcFunder);
    vm.serializeAddress(obj, "depositSIPAImplementation", d.depositSIPAImplementation);
    vm.serializeAddress(obj, "registrationSIPAImplementation", d.registrationSIPAImplementation);
    string memory json = vm.serializeAddress(obj, "firstProverProofSubmitter", d.firstProverProofSubmitter);
    vm.writeJson(json, manifestPath);
  }
}
