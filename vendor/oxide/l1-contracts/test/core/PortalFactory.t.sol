// SPDX-License-Identifier: Apache-2.0
pragma solidity >=0.8.27;
import {IVerifier} from "@aztec/core/interfaces/IVerifier.sol";
import {IRegistry} from "@aztec/governance/interfaces/IRegistry.sol";
import {Ownable} from "@oz/access/Ownable.sol";
import {IERC20} from "@oz/token/ERC20/IERC20.sol";
import {OxidePortal} from "@core/OxidePortal.sol";
import {PortalFactory} from "@core/PortalFactory.sol";
import {ITeeRegistry} from "@core/interfaces/ITeeRegistry.sol";
import {Errors} from "@core/lib/Errors.sol";
import {Errors as OzErrors} from "@oz/utils/Errors.sol";
import {OxidePortalBase} from "@test/core/OxidePortalBase.t.sol";

contract PortalFactoryTest is OxidePortalBase {
  PortalFactory internal factory;

  function setUp() public override {
    super.setUp();
    factory = new PortalFactory(
      OWNER,
      teeRegistry,
      IRegistry(address(registry)),
      ROLLUP_VERSION,
      OxidePortal.RefundVerifiers({
        frozenNotes: IVerifier(address(frozenNotesRefundVerifier)),
        frozenDeposits: IVerifier(address(frozenDepositsRefundVerifier)),
        unprocessedDeposit: IVerifier(address(unprocessedDepositRefundVerifier))
      })
    );
  }

  function test_WhenTheTeeRegistryHasAnotherRollupVersion_ThenTheFactoryReverts() external {
    vm.mockCall(address(teeRegistry), abi.encodeCall(ITeeRegistry.ROLLUP_VERSION, ()), abi.encode(ROLLUP_VERSION + 1));

    vm.expectRevert(Errors.PortalFactory__RollupVersionMismatch.selector);
    new PortalFactory(
      OWNER,
      teeRegistry,
      IRegistry(address(registry)),
      ROLLUP_VERSION,
      OxidePortal.RefundVerifiers({
        frozenNotes: IVerifier(address(frozenNotesRefundVerifier)),
        frozenDeposits: IVerifier(address(frozenDepositsRefundVerifier)),
        unprocessedDeposit: IVerifier(address(unprocessedDepositRefundVerifier))
      })
    );
  }

  function test_WhenTheOwnerDeploys_ThenThePortalLandsAtThePredictedAddress() external {
    address predicted = factory.predictPortalAddress(IERC20(address(underlying)), _caps());

    vm.prank(OWNER);
    OxidePortal deployed = factory.deployPortal(IERC20(address(underlying)), L2_TOKEN, _caps());

    assertEq(address(deployed), predicted);
  }

  function test_WhenTheOwnerDeploys_ThenTheFactoryEmitsPortalDeployed() external {
    address predicted = factory.predictPortalAddress(IERC20(address(underlying)), _caps());

    vm.expectEmit(true, true, true, true, address(factory));
    emit PortalFactory.PortalDeployed(predicted, IERC20(address(underlying)), L2_TOKEN, _caps());

    vm.prank(OWNER);
    factory.deployPortal(IERC20(address(underlying)), L2_TOKEN, _caps());
  }

  function test_WhenTheOwnerDeploys_ThenThePortalGetsTheFactoryAndCallParameters() external {
    vm.prank(OWNER);
    OxidePortal deployed = factory.deployPortal(IERC20(address(underlying)), L2_TOKEN, _caps());

    assertEq(deployed.L2_TOKEN(), L2_TOKEN);
    assertEq(address(deployed.UNDERLYING()), address(underlying));
    assertEq(address(deployed.TEE_REGISTRY()), address(teeRegistry));
    assertEq(deployed.ROLLUP_VERSION(), ROLLUP_VERSION);
    assertEq(deployed.TX_AMOUNT_CAP(), TX_AMOUNT_CAP);
    assertEq(deployed.RATE(), RATE);
    assertEq(deployed.GLOBAL_LIMIT(), GLOBAL_LIMIT);
    assertEq(address(deployed.REGISTRY()), address(registry));
    assertEq(address(deployed.FROZEN_NOTES_REFUND_VERIFIER()), address(frozenNotesRefundVerifier));
    assertEq(address(deployed.FROZEN_DEPOSITS_REFUND_VERIFIER()), address(frozenDepositsRefundVerifier));
    assertEq(address(deployed.UNPROCESSED_DEPOSIT_REFUND_VERIFIER()), address(unprocessedDepositRefundVerifier));
  }

  function test_WhenTheOwnerDeploys_ThenTheFactoryClearsTheL2TokenBeingDeployed() external {
    vm.prank(OWNER);
    factory.deployPortal(IERC20(address(underlying)), L2_TOKEN, _caps());

    assertEq(factory.pendingL2Token(), bytes32(0));
  }

  function test_WhenTheCapsDiffer_ThenThePredictedAddressDiffers() external view {
    PortalFactory.PortalCaps memory other = _caps();
    other.txAmountCap = TX_AMOUNT_CAP - 1;

    assertNotEq(
      factory.predictPortalAddress(IERC20(address(underlying)), _caps()),
      factory.predictPortalAddress(IERC20(address(underlying)), other)
    );
  }

  function test_WhenTheUnderlyingDiffers_ThenThePredictedAddressDiffers() external view {
    assertNotEq(
      factory.predictPortalAddress(IERC20(address(underlying)), _caps()),
      factory.predictPortalAddress(IERC20(address(0xBEEF)), _caps())
    );
  }

  function test_WhenAnotherAccountDeploys_ThenItReverts() external {
    vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, USER));
    vm.prank(USER);
    factory.deployPortal(IERC20(address(underlying)), L2_TOKEN, _caps());
  }

  function test_WhenTheL2TokenIsZero_ThenItReverts() external {
    vm.expectRevert(Errors.PortalFactory__ZeroL2Token.selector);
    vm.prank(OWNER);
    factory.deployPortal(IERC20(address(underlying)), bytes32(0), _caps());
  }

  function test_WhenTheSamePortalIsDeployedTwice_ThenTheSecondReverts() external {
    vm.startPrank(OWNER);
    factory.deployPortal(IERC20(address(underlying)), L2_TOKEN, _caps());

    vm.expectRevert(OzErrors.FailedDeployment.selector);
    factory.deployPortal(IERC20(address(underlying)), bytes32(uint256(0xB12D6F)), _caps());
    vm.stopPrank();
  }

  function _caps() internal pure returns (PortalFactory.PortalCaps memory) {
    return PortalFactory.PortalCaps({txAmountCap: TX_AMOUNT_CAP, rate: RATE, globalLimit: GLOBAL_LIMIT});
  }
}
