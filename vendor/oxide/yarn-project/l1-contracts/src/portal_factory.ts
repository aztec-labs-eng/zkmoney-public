import { EthAddress } from '@aztec-labs/foundation/eth-address';
import type { AztecAddress } from '@aztec-labs/stdlib/aztec-address';

import {
  type Account,
  type Chain,
  type GetContractReturnType,
  type Hex,
  type PublicActions,
  type PublicClient,
  type Transport,
  type WalletClient,
  getContract,
} from 'viem';

import { PortalFactoryAbi } from './artifacts.js';
import { OxidePortalContract } from './oxide_portal.js';
import { type ContractWriteResult, type WriteOptions, maybeWaitForReceipt } from './write_receipt.js';

/** The per-portal values that the portal address commits to. */
export type PortalArgs = {
  underlying: EthAddress;
  txAmountCap: bigint;
  rate: bigint;
  globalLimit: bigint;
};

export class PortalFactoryContract {
  public readonly address: EthAddress;
  private readonly factory: GetContractReturnType<typeof PortalFactoryAbi, PortalFactoryContract['client']>;

  constructor(
    public readonly client: PublicClient | (WalletClient<Transport, Chain, Account> & PublicActions),
    address: Hex | EthAddress,
  ) {
    this.address = address instanceof EthAddress ? address : EthAddress.fromString(address);
    this.factory = getContract({ address: this.address.toString(), abi: PortalFactoryAbi, client });
  }

  /** The address `deployPortal` gives a portal with these values. */
  async predictPortalAddress(args: PortalArgs): Promise<EthAddress> {
    const portal = await this.factory.read.predictPortalAddress([args.underlying.toString(), portalCaps(args)]);
    return EthAddress.fromString(portal);
  }

  async deployPortal(
    args: PortalArgs,
    l2Token: AztecAddress,
    options: WriteOptions = {},
  ): Promise<{ portal: OxidePortalContract } & ContractWriteResult> {
    const client = this.writeClient();
    const portal = await this.predictPortalAddress(args);
    const { write } = getContract({ address: this.address.toString(), abi: PortalFactoryAbi, client });
    const txHash = await write.deployPortal(
      [args.underlying.toString(), l2Token.toString(), portalCaps(args)],
      options.gas === undefined ? {} : { gas: options.gas },
    );
    const result = await maybeWaitForReceipt(client, txHash, options);
    return { ...result, portal: new OxidePortalContract(client, portal) };
  }

  private writeClient() {
    if (!('writeContract' in this.client) || !this.client.account) {
      throw new Error('PortalFactoryContract: this method requires a wallet client with an account');
    }
    return this.client;
  }
}

function portalCaps(args: PortalArgs) {
  return { txAmountCap: args.txAmountCap, rate: args.rate, globalLimit: args.globalLimit };
}
