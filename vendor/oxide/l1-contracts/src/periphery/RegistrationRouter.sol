// SPDX-License-Identifier: Apache-2.0
pragma solidity >=0.8.27;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IOxidePortal} from "@core/interfaces/IOxidePortal.sol";
import {SIPAFactory} from "./SIPAFactory.sol";
import {SIPABase} from "./SIPABase.sol";
import {INameRegistry, DomainAuth} from "./interfaces/INameRegistry.sol";
import {IRegistrationController, SignedTerms, R1Install} from "./interfaces/IRegistrationController.sol";
import {Errors} from "@periphery/Errors.sol";

contract RegistrationRouter {
  using SafeERC20 for IERC20;

  INameRegistry public immutable NAME_REGISTRY;

  constructor(INameRegistry nameRegistry) {
    require(address(nameRegistry) != address(0), Errors.RegistrationRouter__ZeroNameRegistry());
    NAME_REGISTRY = nameRegistry;
  }

  struct RegisterParams {
    bytes32 recoveryCommitment;
    address portal;
    bool resweepable;
    address token;
    uint256 amount;
    bytes registrationData;
    bytes consentSig;
    address bootstrap;
    DomainAuth domainAuth;
    SignedTerms signedTerms;
    R1Install r1Install;
  }

  function register(RegisterParams calldata p) external returns (address sipa) {
    require(p.amount > 0, Errors.RegistrationRouter__ZeroAmount());

    IRegistrationController controller = IRegistrationController(NAME_REGISTRY.registrationController());
    SIPAFactory factory = SIPAFactory(controller.SIPA_FACTORY());
    address implementation = factory.implementationFor(p.portal, SIPABase.Intent.Registration);
    require(implementation != address(0), Errors.RegistrationRouter__NoImplementationForPortal(p.portal));
    sipa = factory.deploySIPA(
      implementation,
      keccak256(p.registrationData),
      p.recoveryCommitment,
      IOxidePortal(p.portal).ROLLUP_VERSION(),
      p.resweepable
    );

    IERC20(p.token).safeTransferFrom(msg.sender, sipa, p.amount);
    SIPABase(sipa)
      .sweep(
        p.token,
        msg.sender,
        p.registrationData,
        abi.encode(p.consentSig, p.bootstrap, p.domainAuth, p.signedTerms, p.r1Install)
      );
  }
}
