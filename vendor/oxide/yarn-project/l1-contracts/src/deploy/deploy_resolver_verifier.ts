import type { Address, PublicClient, WalletClient } from 'viem';

import {
  ResolverRelationsLibAbi,
  ResolverRelationsLibBytecode,
  ResolverVerifierAbi,
  ResolverVerifierBytecode,
  ResolverVerifierLinkReferences,
} from '../artifacts.js';
import { deployContract } from './deploy_contract.js';
import { deployZKTranscriptLib } from './deploy_zk_transcript_lib.js';
import { linkBytecode } from './link_bytecode.js';

export async function deployResolverVerifierAndZkTranscriptLib(
  walletClient: WalletClient,
  publicClient: PublicClient,
): Promise<{ verifier: Address; zkTranscriptLib: Address }> {
  const zkTranscriptLib = await deployZKTranscriptLib(walletClient, publicClient);
  const relationsLib = await deployContract(
    walletClient,
    publicClient,
    ResolverRelationsLibAbi,
    ResolverRelationsLibBytecode,
  );
  const verifierBytecode = linkBytecode(ResolverVerifierBytecode, ResolverVerifierLinkReferences, {
    ZKTranscriptLib: zkTranscriptLib,
    RelationsLib: relationsLib,
  });
  const verifier = await deployContract(walletClient, publicClient, ResolverVerifierAbi, verifierBytecode);
  return { verifier, zkTranscriptLib };
}
