// SPDX-License-Identifier: Apache-2.0
pragma solidity >=0.8.27;
import {DeployOxide} from "../../script/DeployOxide.s.sol";
import {OxideScript} from "../../script/OxideScript.sol";
import {DepositSubsidy} from "@periphery/DepositSubsidy.sol";
import {SIPABase} from "@periphery/SIPABase.sol";
import {DEPOSIT_FEE} from "@periphery/DepositSIPA.sol";
import {RegistrationSIPA, REGISTRATION_SWEEP_FEE} from "@periphery/RegistrationSIPA.sol";
import {METADATA_UPDATE_SWEEP_FEE} from "@periphery/UpdateMetadataSIPA.sol";
import {FirstProverProofSubmitter} from "@periphery/FirstProverProofSubmitter.sol";
import {IFPCFunder} from "@periphery/interfaces/IFPCFunder.sol";
import {OxidePortal} from "@core/OxidePortal.sol";
import {PlainWithdrawalExecutor} from "@periphery/PlainWithdrawalExecutor.sol";
import {MockV3Aggregator} from "@test/mocks/MockV3Aggregator.sol";
import {IFeeJuicePortal} from "@aztec/core/interfaces/IFeeJuicePortal.sol";
import {TestERC20} from "@aztec/mock/TestERC20.sol";
import {IERC20} from "@oz/token/ERC20/IERC20.sol";

import {OxidePortalBase} from "@test/core/OxidePortalBase.t.sol";
import {FakeEnv} from "../helpers/FakeEnv.sol";

contract DeployOxideHarness is DeployOxide, FakeEnv {
  function _envRaw(string memory _name) internal view override(OxideScript, FakeEnv) returns (bool, string memory) {
    return FakeEnv._envRaw(_name);
  }
}

contract DeployOxideTest is OxidePortalBase {
  function _prepareRun() internal returns (DeployOxideHarness deploy, TestERC20 feeAsset) {
    deploy = new DeployOxideHarness();
    deploy.withEnv("OXIDE_OWNER", vm.toString(DEFAULT_SENDER));
    deploy.withEnv("OXIDE_TOKEN", vm.toString(address(underlying)));
    deploy.withEnv("OXIDE_CERT_MANAGER", vm.toString(address(certManager)));
    deploy.withEnv("OXIDE_NITRO_VALIDATOR", vm.toString(address(nitroValidator)));
    deploy.withEnv("OXIDE_REGISTRY", vm.toString(address(registry)));
    deploy.withEnv("OXIDE_ROLLUP_VERSION", vm.toString(ROLLUP_VERSION));
    deploy.withEnv("OXIDE_NAME_REGISTRY", vm.toString(address(nameRegistry)));
    deploy.withEnv("OXIDE_SIPA_FACTORY", vm.toString(address(sipaFactory)));
    deploy.withEnv("OXIDE_PRICE_FEED", vm.toString(address(ethUsdFeed)));
    deploy.withEnv("OXIDE_MANIFEST_PATH", "out/test-oxide-deploy-manifest.json");
    deploy.withEnv("OXIDE_FPC_BENEFICIARY", vm.toString(bytes32(uint256(0xFBC))));
    feeAsset = new TestERC20("Fee", "FEE", address(this));
    rollup.setFeeAsset(IERC20(address(feeAsset)));
    rollup.setFeeAssetPortal(IFeeJuicePortal(address(0xFEEB)));
    vm.prank(OWNER);
    sipaFactory.transferOwnership(DEFAULT_SENDER);
  }

  function test_runSetsDepositConfig() public {
    (DeployOxideHarness deploy, TestERC20 feeAsset) = _prepareRun();

    DeployOxide.Deployment memory d = deploy.run();

    assertEq(address(OxidePortal(d.portal).UNDERLYING()), address(underlying));
    assertEq(OxidePortal(d.portal).FPC_FUNDER(), d.fpcFunder);
    assertEq(OxidePortal(d.portal).FPC_FUNDING_CUT(), 10e16);
    assertEq(IFPCFunder(d.fpcFunder).L2_BENEFICIARY(), bytes32(uint256(0xFBC)));
    assertEq(address(IFPCFunder(d.fpcFunder).FEE_ASSET()), address(feeAsset));
    assertEq(address(IFPCFunder(d.fpcFunder).FEE_JUICE_PORTAL()), address(0xFEEB));
    (uint128 approximateMinProfit, uint128 max, uint128 minFee, uint128 minCreditedAmount, uint128 overheadGas) =
      DepositSubsidy(d.depositSubsidy).$depositConfig();
    assertEq(approximateMinProfit, 0.1e18);
    assertEq(max, 12e18);
    assertEq(minFee, DEPOSIT_FEE);
    assertEq(minCreditedAmount, 1e18);
    assertEq(overheadGas, 0);
    assertTrue(d.operationExecutor.code.length > 0);
    assertEq(address(FirstProverProofSubmitter(d.firstProverProofSubmitter).ROLLUP()), address(rollup));
    assertEq(address(FirstProverProofSubmitter(d.firstProverProofSubmitter).PORTAL()), d.portal);
  }

  function test_runMovesDepositSubsidyToPostDeployOwner() public {
    (DeployOxideHarness deploy,) = _prepareRun();

    DeployOxide.Deployment memory kept = deploy.run();
    assertEq(DepositSubsidy(kept.depositSubsidy).owner(), DEFAULT_SENDER);

    address postDeployOwner = address(0xB0B);
    deploy.withEnv("OXIDE_POST_DEPLOY_OWNER", vm.toString(postDeployOwner));
    DeployOxide.Deployment memory moved = deploy.run();

    DepositSubsidy depositSubsidy = DepositSubsidy(moved.depositSubsidy);
    assertEq(depositSubsidy.owner(), postDeployOwner);
    (uint128 approximateMinProfit,,,,) = depositSubsidy.$depositConfig();
    assertEq(approximateMinProfit, 0.1e18);
  }

  function test_runReadsTheMinimumCreditedAmountFromTheEnvironment() public {
    (DeployOxideHarness deploy,) = _prepareRun();
    deploy.withEnv("OXIDE_DEPOSIT_MIN_CREDITED_AMOUNT", "5000000000000000000");

    DeployOxide.Deployment memory d = deploy.run();

    (,,, uint128 minCreditedAmount,) = DepositSubsidy(d.depositSubsidy).$depositConfig();
    assertEq(minCreditedAmount, 5e18);
  }

  function test_runReadsTheOverheadGasFromTheEnvironment() public {
    (DeployOxideHarness deploy,) = _prepareRun();
    deploy.withEnv("OXIDE_DEPOSIT_OVERHEAD_GAS", "30000");

    DeployOxide.Deployment memory d = deploy.run();

    (,,,, uint128 storedOverheadGas) = DepositSubsidy(d.depositSubsidy).$depositConfig();
    assertEq(storedOverheadGas, 30_000);
  }

  function test_runBlessesIntentImplementationsAgainstTheVersionsPortal() public {
    (DeployOxideHarness deploy,) = _prepareRun();

    DeployOxide.Deployment memory d = deploy.run();

    assertTrue(sipaFactory.intentOf(d.depositSIPAImplementation) == SIPABase.Intent.Deposit);
    assertTrue(sipaFactory.intentOf(d.registrationSIPAImplementation) == SIPABase.Intent.Registration);
    assertTrue(sipaFactory.intentOf(d.updateMetadataSIPAImplementation) == SIPABase.Intent.UpdateMetadata);
    assertEq(sipaFactory.implementationFor(d.portal, SIPABase.Intent.Deposit), d.depositSIPAImplementation);
    assertEq(sipaFactory.implementationFor(d.portal, SIPABase.Intent.Registration), d.registrationSIPAImplementation);
    assertEq(
      sipaFactory.implementationFor(d.portal, SIPABase.Intent.UpdateMetadata), d.updateMetadataSIPAImplementation
    );

    assertEq(address(SIPABase(d.depositSIPAImplementation).PORTAL()), d.portal);
    assertEq(address(SIPABase(d.registrationSIPAImplementation).PORTAL()), d.portal);
    assertEq(address(SIPABase(d.updateMetadataSIPAImplementation).PORTAL()), d.portal);
    assertEq(SIPABase(d.depositSIPAImplementation).DEPOSIT_FEE(), DEPOSIT_FEE);
    assertEq(SIPABase(d.registrationSIPAImplementation).DEPOSIT_FEE(), REGISTRATION_SWEEP_FEE);
    assertEq(SIPABase(d.updateMetadataSIPAImplementation).DEPOSIT_FEE(), METADATA_UPDATE_SWEEP_FEE);
  }

  function test_runWiresPortalSubsidyAndSubmitter() public {
    (DeployOxideHarness deploy,) = _prepareRun();

    DeployOxide.Deployment memory d = deploy.run();

    assertEq(address(SIPABase(d.depositSIPAImplementation).UNDERLYING()), address(underlying));
    assertEq(address(RegistrationSIPA(d.registrationSIPAImplementation).NAME_REGISTRY()), address(nameRegistry));
    assertEq(OxidePortal(d.portal).ROLLUP_VERSION(), ROLLUP_VERSION);
    assertEq(DepositSubsidy(d.depositSubsidy).PORTAL(), d.portal);
    assertEq(address(DepositSubsidy(d.depositSubsidy).SIPA_FACTORY()), address(sipaFactory));
    assertEq(address(FirstProverProofSubmitter(d.firstProverProofSubmitter).PORTAL()), d.portal);
    assertEq(address(FirstProverProofSubmitter(d.firstProverProofSubmitter).ROLLUP()), address(rollup));
    assertEq(PlainWithdrawalExecutor(d.plainWithdrawalExecutor).PORTAL(), d.portal);
    assertEq(address(PlainWithdrawalExecutor(d.plainWithdrawalExecutor).ASSET()), address(underlying));
  }

  function test_versionIndependentDeploySkipsTokenWhenGatedOff() public {
    DeployOxideHarness deploy = new DeployOxideHarness();
    deploy.withEnv("OXIDE_DEPLOY_TOKEN", "false");
    (address token, address certManagerAddr, address nitroValidatorAddr) = deploy.deployVersionIndependentContracts();
    assertEq(token, address(0));
    assertTrue(certManagerAddr.code.length > 0);
    assertTrue(nitroValidatorAddr.code.length > 0);

    deploy.withEnv("OXIDE_DEPLOY_TOKEN", "true");
    (token,,) = deploy.deployVersionIndependentContracts();
    assertTrue(token.code.length > 0);
  }
}
