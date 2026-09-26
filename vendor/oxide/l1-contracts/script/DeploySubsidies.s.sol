// SPDX-License-Identifier: Apache-2.0
pragma solidity >=0.8.27;

import {OxideScript} from "./OxideScript.sol";
import {console} from "forge-std/console.sol";

import {Ownable} from "@oz/access/Ownable.sol";
import {WithdrawalSubsidy} from "@periphery/WithdrawalSubsidy.sol";
import {ProverSubsidy} from "@periphery/ProverSubsidy.sol";
import {AggregatorV3Interface} from "@periphery/interfaces/AggregatorV3Interface.sol";
import {IExecutor} from "@core/interfaces/IExecutor.sol";

contract DeploySubsidies is OxideScript {
  struct BusinessParams {
    address postDeployOwner;
    address portal;
    address priceFeed;
    address plainWithdrawalExecutor;
    WithdrawalSubsidy.FlowPricing withdrawal;
    WithdrawalSubsidy.FlowPricing refund;
    uint256 subsidyPerProverClaim;
  }

  function run() external returns (WithdrawalSubsidy withdrawalSubsidy, ProverSubsidy proverSubsidy) {
    vm.startBroadcast();

    address deployer = msg.sender;
    BusinessParams memory p = _readBusinessParams(deployer);

    withdrawalSubsidy =
      new WithdrawalSubsidy(deployer, p.portal, p.plainWithdrawalExecutor, AggregatorV3Interface(p.priceFeed));
    withdrawalSubsidy.setFlowPricing(IExecutor.Flow.Withdrawal, p.withdrawal);
    withdrawalSubsidy.setFlowPricing(IExecutor.Flow.FrozenNotesRefund, p.refund);
    withdrawalSubsidy.setFlowPricing(IExecutor.Flow.FrozenDepositRefund, p.refund);
    withdrawalSubsidy.setFlowPricing(IExecutor.Flow.UnprocessedDepositRefund, p.refund);

    proverSubsidy = new ProverSubsidy(deployer, p.portal);
    proverSubsidy.setSubsidy(p.subsidyPerProverClaim);

    if (p.postDeployOwner != deployer) {
      Ownable(address(withdrawalSubsidy)).transferOwnership(p.postDeployOwner);
      Ownable(address(proverSubsidy)).transferOwnership(p.postDeployOwner);
    }

    vm.stopBroadcast();

    console.log("WithdrawalSubsidy ", address(withdrawalSubsidy));
    console.log("ProverSubsidy     ", address(proverSubsidy));
    console.log("  portal                           ", p.portal);
    console.log("  owner                            ", p.postDeployOwner);
    console.log("  executor                         ", p.plainWithdrawalExecutor);

    _writeManifest(address(withdrawalSubsidy), address(proverSubsidy));
  }

  function _writeManifest(address _withdrawalSubsidy, address _proverSubsidy) internal {
    string memory manifestPath = _envOr("OXIDE_SUBSIDIES_MANIFEST_PATH", string("out/oxide-subsidies-manifest.json"));
    string memory obj = "oxideSubsidiesManifest";
    vm.serializeAddress(obj, "withdrawalSubsidy", _withdrawalSubsidy);
    string memory json = vm.serializeAddress(obj, "proverSubsidy", _proverSubsidy);
    vm.writeJson(json, manifestPath);
  }

  function _readBusinessParams(address _deployer) internal view returns (BusinessParams memory p) {
    p.postDeployOwner = _envOr("OXIDE_POST_DEPLOY_OWNER", _envOr("OXIDE_OWNER", _deployer));
    p.portal = _envAddress("OXIDE_PORTAL");
    p.priceFeed = _envAddress("OXIDE_PRICE_FEED");
    p.plainWithdrawalExecutor = _envAddress("OXIDE_PLAIN_WITHDRAWAL_EXECUTOR");

    p.withdrawal = WithdrawalSubsidy.FlowPricing({
      startPriceWei: _envOr("OXIDE_WITHDRAWAL_SUBSIDY_START_PRICE_WEI", uint256(0)),
      maxSubsidy: _envOr("OXIDE_MAX_SUBSIDY_PER_WITHDRAWAL", uint256(0))
    });
    p.refund = WithdrawalSubsidy.FlowPricing({
      startPriceWei: _envOr("OXIDE_REFUND_SUBSIDY_START_PRICE_WEI", uint256(0)),
      maxSubsidy: _envOr("OXIDE_MAX_SUBSIDY_PER_REFUND", uint256(0))
    });
    p.subsidyPerProverClaim = _envOr("OXIDE_SUBSIDY_PER_PROVER_CLAIM", uint256(0));
  }
}
