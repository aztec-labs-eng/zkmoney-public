import type { Address, PublicClient, WalletClient } from 'viem';

import { RegistrationControllerAbi } from './artifacts.js';
import type { R1InstallGas } from './r1_install.js';
import { maybeWaitForReceipt } from './write_receipt.js';

/** A controller's immutable registration fee: the whole fee a registration charges when no signed terms apply. */
export async function readRegistrationFee(publicClient: PublicClient, controller: Address): Promise<bigint> {
  return (await publicClient.readContract({
    address: controller,
    abi: RegistrationControllerAbi,
    functionName: 'REGISTRATION_FEE',
  })) as bigint;
}

export async function readRegistrationMin(publicClient: PublicClient, controller: Address): Promise<bigint> {
  return (await publicClient.readContract({
    address: controller,
    abi: RegistrationControllerAbi,
    functionName: 'REGISTRATION_MIN',
  })) as bigint;
}

/** The gas limits a deployed controller puts in the R1 install UserOp it sweeps. */
export async function readR1InstallGas(publicClient: PublicClient, controller: Address): Promise<R1InstallGas> {
  const read = async (
    functionName: 'R1_INSTALL_VERIFICATION_GAS' | 'R1_INSTALL_CALL_GAS_BASE' | 'R1_INSTALL_CALL_GAS_PER_WORD',
  ) =>
    (await publicClient.readContract({ address: controller, abi: RegistrationControllerAbi, functionName })) as bigint;
  const [verification, callBase, callPerWord] = await Promise.all([
    read('R1_INSTALL_VERIFICATION_GAS'),
    read('R1_INSTALL_CALL_GAS_BASE'),
    read('R1_INSTALL_CALL_GAS_PER_WORD'),
  ]);
  return { verification, callBase, callPerWord };
}

export async function readIsBeneficiary(
  publicClient: PublicClient,
  controller: Address,
  beneficiary: Address,
): Promise<boolean> {
  return (await publicClient.readContract({
    address: controller,
    abi: RegistrationControllerAbi,
    functionName: 'isBeneficiary',
    args: [beneficiary],
  })) as boolean;
}

export async function addBeneficiary(
  walletClient: WalletClient,
  publicClient: PublicClient,
  controller: Address,
  beneficiary: Address,
): Promise<void> {
  const hash = await walletClient.writeContract({
    address: controller,
    abi: RegistrationControllerAbi,
    functionName: 'addBeneficiary',
    args: [beneficiary],
  } as any);
  await maybeWaitForReceipt(publicClient, hash, { waitForReceipt: true });
}
