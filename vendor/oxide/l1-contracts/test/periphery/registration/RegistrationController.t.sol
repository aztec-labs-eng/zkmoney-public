// SPDX-License-Identifier: Apache-2.0
pragma solidity >=0.8.27;
import {RegistrationTestBase} from "./RegistrationTestBase.sol";
import {AccountMetadataRegistry} from "@periphery/AccountMetadataRegistry.sol";
import {RegistrationController} from "@periphery/RegistrationController.sol";
import {INameRegistry} from "@periphery/interfaces/INameRegistry.sol";
import {INamePortal} from "@periphery/interfaces/INamePortal.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {DomainAuth} from "@periphery/interfaces/INameRegistry.sol";
import {SIPABase} from "@periphery/SIPABase.sol";
import {TestERC20} from "@aztec/mock/TestERC20.sol";
import {Errors} from "@periphery/Errors.sol";

contract RegistrationControllerTest is RegistrationTestBase {
  uint256 internal constant DEPOSIT = 100 ether;

  function _deadline() internal view returns (uint256) {
    return block.timestamp + 1 days;
  }

  function _proofs(bytes memory registrationData) internal returns (bytes memory) {
    return _regProofs(
      _consentSig(bootstrapKey, registrationData),
      _domainAuth(NAME_HASH, defaultOwner, nextNonce++, _deadline()),
      _noTerms()
    );
  }

  function test_registerRejectsNonSIPACaller() external {
    bytes memory registrationData = _registrationData(NAME_HASH, defaultOwner);
    bytes memory proofs = _proofs(registrationData);
    vm.expectRevert(abi.encodeWithSelector(Errors.RegistrationController__CallerNotSIPA.selector, address(this)));
    registrationController.register(address(underlying), DEPOSIT, registrationData, proofs);
  }

  function test_claimForRejectsNonControllerCaller() external {
    DomainAuth memory auth = _domainAuth(NAME_HASH, defaultOwner, nextNonce++, _deadline());
    vm.expectRevert(
      abi.encodeWithSelector(Errors.NameRegistry__CallerNotRegistrationController.selector, address(this))
    );
    nameRegistry.claimName(NAME_HASH, defaultOwner, auth);
  }

  function test_setRecordRejectsNonControllerNonUserCaller() external {
    vm.expectRevert(
      abi.encodeWithSelector(Errors.AccountMetadataRegistry__Unauthorized.selector, address(this), defaultOwner)
    );
    metadataRegistry.setUserRecord(
      defaultOwner, _record(AccountMetadataRegistry.K1Point(G_X, G_Y), L2_ADDRESS, resolverOperatorAddr, ROLLUP_VERSION)
    );
  }

  function test_wrongFeeTokenReverts() external {
    TestERC20 other = new TestERC20("Other", "OTH", address(this));
    bytes memory registrationData = _registrationData(NAME_HASH, defaultOwner);
    SIPABase sipa = _deployRegistrationSIPA(registrationData);
    other.mint(address(sipa), DEPOSIT);
    bytes memory proofs = _proofs(registrationData);

    vm.expectRevert(
      abi.encodeWithSelector(
        Errors.RegistrationController__FeeTokenMismatch.selector, address(other), address(underlying)
      )
    );
    sipa.sweep(address(other), relayer, registrationData, proofs);
  }

  function test_belowFloorReverts() external {
    bytes memory registrationData = _registrationData(NAME_HASH, defaultOwner);
    uint256 amount = REGISTRATION_MIN + REGISTRATION_FEE - 1;
    SIPABase sipa = _deployAndFund(registrationData, amount);
    bytes memory consent = _consentSig(bootstrapKey, registrationData);
    DomainAuth memory auth = _domainAuth(NAME_HASH, defaultOwner, nextNonce++, _deadline());

    vm.expectRevert(
      abi.encodeWithSelector(
        Errors.RegistrationController__BalanceBelowFloor.selector, amount, REGISTRATION_MIN + REGISTRATION_FEE
      )
    );
    _sweepRegistration(sipa, registrationData, consent, auth, _noTerms());
  }

  function test_constructorRejectsZeroNamePortal() external {
    vm.expectRevert(Errors.RegistrationController__ZeroNamePortal.selector);
    new RegistrationController(
      INameRegistry(address(nameRegistry)),
      sipaFactory,
      accountFactory,
      INamePortal(address(0)),
      IERC20(address(underlying)),
      REGISTRATION_MIN,
      REGISTRATION_FEE,
      FEE_BENEFICIARY
    );
  }

  function test_seedsInitialBeneficiaryAsIdZero() external view {
    assertEq(registrationController.beneficiaries(0), FEE_BENEFICIARY);
    assertEq(registrationController.nextBeneficiaryId(), 1);
    assertTrue(registrationController.isBeneficiary(FEE_BENEFICIARY));
  }

  function test_addBeneficiaryAssignsSequentialIds() external {
    address funder2 = makeAddr("funder2");
    vm.prank(regDomainOwner);
    uint256 id = registrationController.addBeneficiary(funder2);
    assertEq(id, 1);
    assertEq(registrationController.beneficiaries(1), funder2);
    assertEq(registrationController.nextBeneficiaryId(), 2);
    assertTrue(registrationController.isBeneficiary(funder2));
  }

  function test_addBeneficiaryRejectsZeroAddress() external {
    vm.prank(regDomainOwner);
    vm.expectRevert(Errors.RegistrationController__ZeroBeneficiary.selector);
    registrationController.addBeneficiary(address(0));
  }

  function test_unallowlistedBeneficiaryReverts() external {
    address stranger = makeAddr("stranger");
    bytes memory registrationData = _registrationDataFull(
      NAME_HASH,
      defaultOwner,
      AccountMetadataRegistry.K1Point(G_X, G_Y),
      L2_ADDRESS,
      resolverOperatorAddr,
      ROLLUP_VERSION,
      REGISTRATION_FEE,
      stranger,
      NAME_PORTAL_RECIPIENT
    );
    SIPABase sipa = _deployAndFund(registrationData, DEPOSIT);
    bytes memory consent = _consentSig(bootstrapKey, registrationData);
    DomainAuth memory auth = _domainAuth(NAME_HASH, defaultOwner, nextNonce++, _deadline());

    vm.expectRevert(abi.encodeWithSelector(Errors.RegistrationController__BeneficiaryNotAllowlisted.selector, stranger));
    _sweepRegistration(sipa, registrationData, consent, auth, _noTerms());
  }

  function test_feeRoutesToAllowlistedBeneficiary() external {
    address funder2 = makeAddr("funder2");
    vm.prank(regDomainOwner);
    registrationController.addBeneficiary(funder2);

    bytes memory registrationData = _registrationDataFull(
      NAME_HASH,
      defaultOwner,
      AccountMetadataRegistry.K1Point(G_X, G_Y),
      L2_ADDRESS,
      resolverOperatorAddr,
      ROLLUP_VERSION,
      REGISTRATION_FEE,
      funder2,
      NAME_PORTAL_RECIPIENT
    );
    SIPABase sipa = _deployAndFund(registrationData, DEPOSIT);
    _sweepRegistration(
      sipa,
      registrationData,
      _consentSig(bootstrapKey, registrationData),
      _domainAuth(NAME_HASH, defaultOwner, nextNonce++, _deadline()),
      _noTerms()
    );

    assertEq(nameRegistry.ownerOf(NAME_HASH), defaultOwner);
    assertEq(underlying.balanceOf(funder2), REGISTRATION_FUNDER_CUT);
    assertEq(underlying.balanceOf(FEE_BENEFICIARY), 0);
  }
}
