// SPDX-License-Identifier: Apache-2.0
pragma solidity >=0.8.27;
import {Test} from "forge-std/Test.sol";

import {DeploySubsidies} from "../../script/DeploySubsidies.s.sol";
import {OxideScript} from "../../script/OxideScript.sol";
import {FakeEnv} from "../helpers/FakeEnv.sol";

contract DeployHarness is DeploySubsidies, FakeEnv {
  function _envRaw(string memory _name) internal view override(OxideScript, FakeEnv) returns (bool, string memory) {
    return FakeEnv._envRaw(_name);
  }

  function businessParams(address _deployer) external view returns (BusinessParams memory) {
    return _readBusinessParams(_deployer);
  }
}

contract DeploySubsidiesTest is Test {
  DeployHarness internal harness;

  function setUp() public {
    harness = new DeployHarness();
    harness.withEnv("OXIDE_PORTAL", vm.toString(address(0xdead)));
    harness.withEnv("OXIDE_PRICE_FEED", vm.toString(address(0xfeed)));
    harness.withEnv("OXIDE_PLAIN_WITHDRAWAL_EXECUTOR", vm.toString(address(0xE5EC)));
  }

  function test_GivenPricingEnv_ThenDefaultsApplyUntilOverridden() public {
    DeploySubsidies.BusinessParams memory p = harness.businessParams(address(this));

    assertEq(p.withdrawal.startPriceWei, 0, "an unset kick-in price subsidizes from 0");
    assertEq(p.refund.startPriceWei, 0);
    assertEq(p.withdrawal.maxSubsidy, 0, "an unset cap deploys withdrawals switched off");
    assertEq(p.refund.maxSubsidy, 0, "an unset refund cap deploys refunds switched off");
    assertEq(p.subsidyPerProverClaim, 0, "an unset per-claim subsidy deploys prover claims switched off");
    assertEq(
      p.plainWithdrawalExecutor, address(0xE5EC), "the executor the withdrawal subsidy binds to comes from the env"
    );

    harness.withEnv("OXIDE_WITHDRAWAL_SUBSIDY_START_PRICE_WEI", "2000000000");
    harness.withEnv("OXIDE_REFUND_SUBSIDY_START_PRICE_WEI", "3000000000");
    harness.withEnv("OXIDE_MAX_SUBSIDY_PER_WITHDRAWAL", "60000000000000000000");
    harness.withEnv("OXIDE_MAX_SUBSIDY_PER_REFUND", "90000000000000000000");
    harness.withEnv("OXIDE_SUBSIDY_PER_PROVER_CLAIM", "75000000000000000000");
    harness.withEnv("OXIDE_PLAIN_WITHDRAWAL_EXECUTOR", vm.toString(address(0xBEEF)));

    p = harness.businessParams(address(this));

    assertEq(p.withdrawal.startPriceWei, 2 gwei);
    assertEq(p.refund.startPriceWei, 3 gwei);
    assertEq(p.withdrawal.maxSubsidy, 60 ether);
    assertEq(p.refund.maxSubsidy, 90 ether);
    assertEq(p.subsidyPerProverClaim, 75 ether);
    assertEq(p.plainWithdrawalExecutor, address(0xBEEF));
  }

  function test_GivenPostDeployOwnerEnv_ThenItOverridesTheOwnerFallback() public {
    address deployer = address(0xDEE);

    harness.withEnv("OXIDE_POST_DEPLOY_OWNER", vm.toString(address(0xB0B)));
    assertEq(harness.businessParams(deployer).postDeployOwner, address(0xB0B));

    harness.withoutEnv("OXIDE_POST_DEPLOY_OWNER");
    assertEq(harness.businessParams(deployer).postDeployOwner, deployer, "unset owners fall back to the deployer");

    harness.withEnv("OXIDE_POST_DEPLOY_OWNER", "");
    assertEq(harness.businessParams(deployer).postDeployOwner, deployer, "an empty owner counts as unset");

    harness.withEnv("OXIDE_OWNER", vm.toString(address(0xA11CE)));
    assertEq(harness.businessParams(deployer).postDeployOwner, address(0xA11CE), "OXIDE_OWNER beats the deployer");

    harness.withEnv("OXIDE_POST_DEPLOY_OWNER", vm.toString(address(0xB0B)));
    assertEq(harness.businessParams(deployer).postDeployOwner, address(0xB0B), "OXIDE_POST_DEPLOY_OWNER beats both");
  }

  function test_GivenMissingPortal_ThenReadingParamsReverts() public {
    harness.withoutEnv("OXIDE_PORTAL");

    vm.expectRevert(abi.encodeWithSelector(OxideScript.OxideScript__MissingEnv.selector, "OXIDE_PORTAL"));
    harness.businessParams(address(0xDEE));
  }
}
