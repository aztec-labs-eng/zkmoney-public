// ─────────────────────────────────────────────────────────────────────────────
// VENDORED from oxide@bd42c7c `yarn-project/end-to-end-oxide/src/test_utils/deploy_test_cert_manager.ts`.
//
// Upstream made the `@oxide/end-to-end-oxide` package un-exported (test-internal), so obsidion can no
// longer import `deployTestCertManager` / `TestCertManagerRootArgs` from it. Vendored alongside
// `gen_test_attestation.ts`; the `./gen_test_attestation.js` import stays a sibling reference. Its
// Re-sync on the next oxide bump.
// ─────────────────────────────────────────────────────────────────────────────
import { deployL1Contract } from '@aztec/ethereum/deploy-l1-contract';
import type { ExtendedViemWalletClient } from '@aztec/ethereum/types';
import type { EthAddress } from '@aztec/foundation/eth-address';

import { TestCertManagerAbi, TestCertManagerBytecode } from '@oxide/l1-contracts';

import type { Hex } from 'viem';

import type { RootArgs } from './gen_test_attestation.js';

export type TestCertManagerRootArgs = RootArgs;

/**
 * Deploys `TestCertManager(rootArgs)`. Pair with a real `NitroValidator` (also from
 * `@oxide/l1-contracts`'s deploy helpers) to validate self-issued test attestation chains
 * end-to-end — `TestCertManager` knows the test root, so it accepts cabundle entries signed by it.
 */
export async function deployTestCertManager(
  client: ExtendedViemWalletClient,
  rootArgs: TestCertManagerRootArgs,
): Promise<EthAddress> {
  const { address } = await deployL1Contract(client, TestCertManagerAbi, TestCertManagerBytecode, [
    {
      certHash: rootArgs.certHash.toString() as Hex,
      notAfter: BigInt(rootArgs.notAfter),
      maxPathLen: BigInt(rootArgs.maxPathLen),
      subjectHash: rootArgs.subjectHash.toString() as Hex,
      pubKey: ('0x' + rootArgs.pubKey.toString('hex')) as Hex,
    },
  ]);
  return address;
}
