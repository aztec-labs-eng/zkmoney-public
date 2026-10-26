import type { Address, PublicClient, WalletClient } from 'viem';

import { ForwardingTableAbi, ForwardingTableBytecode } from '../artifacts.js';
import { SipaIntent } from '../sipa_factory.js';
import { deployContract } from './deploy_contract.js';

/**
 * The sweep tip of each intent in a forwarding table row, in the units of the row's token. The relayer gets the tip
 * from each sweep.
 *
 * The tips are different because the sweeps are different: a registration writes two registries, deploys the owner's
 * 4337 account and notifies the name portal, but a plain deposit does none of these. The registration tip is the
 * relayer's part of the registration fee; the FPC funder gets the remainder.
 */
export const DEPOSIT_SWEEP_FEE = 250_000_000_000_000_000n;
export const REGISTRATION_SWEEP_FEE = 500_000_000_000_000_000n;
export const USER_OP_SWEEP_FEE = 500_000_000_000_000_000n;

/** The fees of one intent in a forwarding table row. `IForwardingTable.IntentFees`. */
export interface ForwardingTableIntentFees {
  intent: SipaIntent;
  beneficiaryFee: bigint;
  sweepTip: bigint;
}

/** One row that the forwarding table constructor lists. `IForwardingTable.InitialRow`. */
export interface ForwardingTableInitialRow {
  token: Address;
  portal: Address;
  intents: ForwardingTableIntentFees[];
}

/** The three intents with the default sweep tips and no beneficiary fee. */
export const DEFAULT_FORWARDING_TABLE_INTENTS: ForwardingTableIntentFees[] = [
  { intent: SipaIntent.Deposit, beneficiaryFee: 0n, sweepTip: DEPOSIT_SWEEP_FEE },
  { intent: SipaIntent.Registration, beneficiaryFee: 0n, sweepTip: REGISTRATION_SWEEP_FEE },
  { intent: SipaIntent.UserOp, beneficiaryFee: 0n, sweepTip: USER_OP_SWEEP_FEE },
];

/**
 * Deploy a forwarding table for one rollup version. The constructor lists `rows`, so the table can route sweeps
 * without a later `addRow`. Each row's portal must hold the row's token and have the table's rollup version.
 */
export function deployForwardingTable(
  walletClient: WalletClient,
  publicClient: PublicClient,
  args: { owner: Address; rollupVersion: bigint; beneficiary: Address; rows: ForwardingTableInitialRow[] },
): Promise<Address> {
  return deployContract(walletClient, publicClient, ForwardingTableAbi, ForwardingTableBytecode, [args]);
}
