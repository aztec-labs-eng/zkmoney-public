import type { Address, PublicClient, WalletClient } from 'viem';

import { RegistrationControllerAbi, RegistrationControllerBytecode } from '../artifacts.js';
import { deployContract } from './deploy_contract.js';

/**
 * Deploys the RegistrationController (payment policy, owner consent verification, name claim + record write, 4337
 * account deploy, name-portal notification). Bless it afterward with `NameRegistry.updateRegistrationController`
 * (owner gated). It reads the domain owner and the metadata registry from the name registry; `initialBeneficiary` is
 * seeded as beneficiary id 0.
 */
export function deployRegistrationController(
  walletClient: WalletClient,
  publicClient: PublicClient,
  nameRegistry: Address,
  sipaFactory: Address,
  accountFactory: Address,
  namePortal: Address,
  feeToken: Address,
  registrationMin: bigint,
  registrationFee: bigint,
  initialBeneficiary: Address,
): Promise<Address> {
  return deployContract(walletClient, publicClient, RegistrationControllerAbi, RegistrationControllerBytecode, [
    nameRegistry,
    sipaFactory,
    accountFactory,
    namePortal,
    feeToken,
    registrationMin,
    registrationFee,
    initialBeneficiary,
  ]);
}
