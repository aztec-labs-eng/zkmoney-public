// SPDX-License-Identifier: Apache-2.0
pragma solidity >=0.8.27;
import {RegistrationTestBase} from "@test/periphery/registration/RegistrationTestBase.sol";
import {RegistrationRouter} from "@periphery/RegistrationRouter.sol";
import {INameRegistry} from "@periphery/interfaces/INameRegistry.sol";
import {SIPABase} from "@periphery/SIPABase.sol";
import {REGISTRATION_SWEEP_FEE} from "@periphery/RegistrationSIPA.sol";
import {Errors} from "@periphery/Errors.sol";

contract RegistrationRouterTest is RegistrationTestBase {
  uint256 internal constant DEPOSIT = 100 ether;

  RegistrationRouter internal router;
  address internal caller = makeAddr("selfCustodyCaller");

  function setUp() public override {
    super.setUp();
    router = new RegistrationRouter(INameRegistry(address(nameRegistry)));
    underlying.mint(caller, DEPOSIT * 10);
    vm.prank(caller);
    underlying.approve(address(router), type(uint256).max);
  }

  function _params(bytes memory registrationData, uint256 amount)
    internal
    returns (RegistrationRouter.RegisterParams memory p)
  {
    p.recoveryCommitment = _recoveryCommitment("recovery");
    p.portal = address(portal);
    p.resweepable = true;
    p.token = address(underlying);
    p.amount = amount;
    p.registrationData = registrationData;
    p.consentSig = _consentSig(bootstrapKey, registrationData);
    p.bootstrap = bootstrap;
    p.domainAuth = _domainAuth(NAME_HASH, defaultOwner, nextNonce++, block.timestamp + 1 days);
    p.signedTerms = _noTerms();
    p.r1Install = _r1Install(bootstrapKey, defaultOwner);
  }

  function test_oneTxRegistrationRegistersAndReturnsRelayerFee() external {
    bytes memory registrationData = _registrationData(NAME_HASH, defaultOwner);
    RegistrationRouter.RegisterParams memory p = _params(registrationData, DEPOSIT);

    uint256 callerBefore = underlying.balanceOf(caller);
    uint256 portalBefore = underlying.balanceOf(address(portal));

    vm.prank(caller);
    address sipa = router.register(p);

    assertEq(nameRegistry.ownerOf(NAME_HASH), defaultOwner);
    assertEq(underlying.balanceOf(FEE_BENEFICIARY), REGISTRATION_FUNDER_CUT);
    assertEq(underlying.balanceOf(caller), callerBefore - DEPOSIT + REGISTRATION_SWEEP_FEE);
    assertEq(underlying.balanceOf(address(portal)) - portalBefore, DEPOSIT - REGISTRATION_FEE);
    assertEq(underlying.balanceOf(sipa), 0);
  }

  function test_routerHoldsNoTokensAfterRegistration() external {
    bytes memory registrationData = _registrationData(NAME_HASH, defaultOwner);
    RegistrationRouter.RegisterParams memory p = _params(registrationData, DEPOSIT);

    vm.prank(caller);
    router.register(p);

    assertEq(underlying.balanceOf(address(router)), 0);
  }

  function test_zeroAmountReverts() external {
    bytes memory registrationData = _registrationData(NAME_HASH, defaultOwner);
    RegistrationRouter.RegisterParams memory p = _params(registrationData, 0);

    vm.prank(caller);
    vm.expectRevert(Errors.RegistrationRouter__ZeroAmount.selector);
    router.register(p);
  }

  function test_routerDoesNotBypassConsent() external {
    bytes memory registrationData = _registrationData(NAME_HASH, defaultOwner);
    RegistrationRouter.RegisterParams memory p = _params(registrationData, DEPOSIT);
    (, uint256 attackerKey) = makeAddrAndKey("attacker");
    p.consentSig = _consentSig(attackerKey, registrationData);

    vm.prank(caller);
    vm.expectRevert();
    router.register(p);
  }

  function test_routerCommitsSIPAToRegistrationData() external {
    bytes memory registrationData = _registrationData(NAME_HASH, defaultOwner);
    RegistrationRouter.RegisterParams memory p = _params(registrationData, DEPOSIT);

    vm.prank(caller);
    address sipa = router.register(p);

    assertEq(SIPABase(sipa).intentHash(), keccak256(registrationData));
  }
}
