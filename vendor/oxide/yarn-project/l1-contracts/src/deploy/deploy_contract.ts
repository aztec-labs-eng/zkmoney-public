import type { Abi, Address, Hex, PublicClient, WalletClient } from 'viem';

export async function deployContract(
  walletClient: WalletClient,
  publicClient: PublicClient,
  abi: Abi,
  bytecode: Hex,
  args: readonly unknown[] = [],
): Promise<Address> {
  const hash = await walletClient.deployContract({ abi, bytecode, args } as any);
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  if (!receipt.contractAddress) {
    throw new Error(`deployment ${hash} did not produce a contract address`);
  }
  return receipt.contractAddress;
}
