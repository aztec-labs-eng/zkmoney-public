import { deployL1Contract } from '@aztec/ethereum/deploy-l1-contract';
import type { ExtendedViemWalletClient } from '@aztec/ethereum/types';
import type { EthAddress } from '@aztec/foundation/eth-address';

import { OxidePortalAbi, OxidePortalBytecode } from '../abis/OxidePortal.js';
import { OxidePortalContract } from '../oxide_portal.js';

/**
 * The oxide refund proof verifiers forwarded into the OxidePortal constructor as the `_verifiers`
 * tuple. Mirrors `OxidePortal.RefundVerifiers` field-for-field; each is a generated Honk verifier.
 */
export interface PortalRefundVerifiers {
  frozenNotes: EthAddress;
  frozenDeposit: EthAddress;
  unprocessedDeposit: EthAddress;
}

export interface DeployOxidePortalArgs {
  /** L1 owner — only address allowed to call `initialize`, `approveTeePcr0`, `freeze`. */
  owner: EthAddress;
  fpcFunder: EthAddress;
  fpcFundingCut: bigint;
  certManager: EthAddress;
  nitroValidator: EthAddress;
  /** ERC20 the portal escrows. Fee-on-transfer / rebasing tokens are unsupported. */
  underlying: EthAddress;
  /** Aztec registry; the portal resolves the rollup (and its inbox/outbox) from it by version. */
  registry: EthAddress;
  rollupVersion: bigint;
  verifiers: PortalRefundVerifiers;
  rate: bigint;
  globalLimit: bigint;
}

/**
 * Deploys the `OxidePortal` and returns a ready-to-use `OxidePortalContract` wrapper bound to the
 * deployed address. Does **not** call `initialize` — callers do that once the L2 portal address
 * is known. Does **not** register a TEE.
 */
export async function deployOxidePortal(
  client: ExtendedViemWalletClient,
  args: DeployOxidePortalArgs,
): Promise<OxidePortalContract> {
  const { address } = await deployL1Contract(client, OxidePortalAbi, OxidePortalBytecode, [
    args.owner.toString(),
    { funder: args.fpcFunder.toString(), cut: args.fpcFundingCut },
    args.certManager.toString(),
    args.nitroValidator.toString(),
    args.underlying.toString(),
    args.registry.toString(),
    args.rollupVersion,
    {
      frozenNotes: args.verifiers.frozenNotes.toString(),
      frozenDeposit: args.verifiers.frozenDeposit.toString(),
      unprocessedDeposit: args.verifiers.unprocessedDeposit.toString(),
    },
    args.rate,
    args.globalLimit,
  ]);
  return new OxidePortalContract(client, address);
}
