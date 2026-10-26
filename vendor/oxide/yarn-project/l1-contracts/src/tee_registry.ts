import { Buffer32 } from '@aztec-labs/foundation/buffer';
import { Fr } from '@aztec-labs/foundation/curves/bn254';
import { EthAddress } from '@aztec-labs/foundation/eth-address';

import {
  type Account,
  type Chain,
  type ContractFunctionArgs,
  type ContractFunctionName,
  type GetContractReturnType,
  type Hex,
  type PublicActions,
  type PublicClient,
  type Transport,
  type WalletClient,
  getContract,
} from 'viem';

import { CertManagerAbi } from './abis/CertManager.js';
import { NitroValidatorAbi } from './abis/NitroValidator.js';
import { TeeRegistryAbi } from './artifacts.js';
import { type ContractWriteResult, type WriteOptions, writeWithGasLimit } from './write_receipt.js';

export interface TEEKeys {
  pubKeyX: Buffer32;
  pubKeyY: Buffer32;
  encPubKeyX: Buffer32;
  encPubKeyY: Buffer32;
}

export class TeeRegistryContract {
  public readonly address: EthAddress;
  private readonly registry: GetContractReturnType<typeof TeeRegistryAbi, TeeRegistryContract['client']>;
  private certManager?: GetContractReturnType<typeof CertManagerAbi, TeeRegistryContract['client']>;
  private nitroValidator?: GetContractReturnType<typeof NitroValidatorAbi, TeeRegistryContract['client']>;

  constructor(
    public readonly client: PublicClient | (WalletClient<Transport, Chain, Account> & PublicActions),
    address: Hex | EthAddress,
  ) {
    this.address = address instanceof EthAddress ? address : EthAddress.fromString(address);
    this.registry = getContract({ address: this.address.toString(), abi: TeeRegistryAbi, client });
  }

  async getPcr0Hash(): Promise<Buffer32> {
    const pcr0Hash = await this.registry.read.PCR0_HASH();
    return Buffer32.fromString(pcr0Hash);
  }

  isTeeRegistered(tee: EthAddress): Promise<boolean> {
    return this.registry.read.isTeeRegistered([tee.toString()]);
  }

  async getRegistration(tee: EthAddress): Promise<{ leafIndex: bigint; keys: TEEKeys }> {
    const [{ leafIndex }, [pubKeyX, pubKeyY, encPubKeyX, encPubKeyY]] = await Promise.all([
      this.getRegistrationMessage(tee),
      this.registry.read.$teeKeys([tee.toString()]),
    ]);
    return {
      leafIndex,
      keys: {
        pubKeyX: Buffer32.fromString(pubKeyX),
        pubKeyY: Buffer32.fromString(pubKeyY),
        encPubKeyX: Buffer32.fromString(encPubKeyX),
        encPubKeyY: Buffer32.fromString(encPubKeyY),
      },
    };
  }

  async getRegistrationMessage(tee: EthAddress): Promise<{ messageKey: Fr; leafIndex: bigint }> {
    const [messageKey, leafIndex] = await this.registry.read.$registrationMessages([tee.toString()]);
    if (BigInt(messageKey) === 0n) {
      throw new Error(`TEE ${tee} is not registered on TeeRegistry ${this.address}`);
    }
    return { messageKey: Fr.fromHexString(messageKey), leafIndex };
  }

  verifyTeeCACert(cert: Buffer, parentCertHash: Buffer32, options: WriteOptions = {}): Promise<ContractWriteResult> {
    return this.write('verifyTeeCACert', [`0x${cert.toString('hex')}`, parentCertHash.toString() as Hex], options);
  }

  verifyTeeClientCert(
    cert: Buffer,
    parentCertHash: Buffer32,
    options: WriteOptions = {},
  ): Promise<ContractWriteResult> {
    return this.write('verifyTeeClientCert', [`0x${cert.toString('hex')}`, parentCertHash.toString() as Hex], options);
  }

  verifyTeeAttestationHash(attestationTbs: Buffer, options: WriteOptions = {}): Promise<ContractWriteResult> {
    return this.write('verifyTeeAttestationHash', [`0x${attestationTbs.toString('hex')}`], options);
  }

  verifyTeeAttestationSig(
    attestationTbsKeccak: Buffer32,
    signature: Buffer,
    leafCertHash: Buffer32,
    options: WriteOptions = {},
  ): Promise<ContractWriteResult> {
    return this.write(
      'verifyTeeAttestationSig',
      [attestationTbsKeccak.toString() as Hex, `0x${signature.toString('hex')}`, leafCertHash.toString() as Hex],
      options,
    );
  }

  /** Whether the cert manager already caches a verified entry for this cert (keyed by keccak256(cert)). */
  async isTeeCertStaged(certHash: Buffer32): Promise<boolean> {
    const cm = await this.certManagerContract();
    return (await cm.read.verified([certHash.toString() as Hex])) !== '0x';
  }

  async isTeeAttestationHashStaged(attestationTbsKeccak: Buffer32): Promise<boolean> {
    const nv = await this.nitroValidatorContract();
    return (await nv.read.attestationSha384([attestationTbsKeccak.toString() as Hex])) !== '0x';
  }

  async isTeeAttestationSigStaged(attestationTbsKeccak: Buffer32): Promise<boolean> {
    const nv = await this.nitroValidatorContract();
    return BigInt(await nv.read.verifiedAttestationLeaf([attestationTbsKeccak.toString() as Hex])) !== 0n;
  }

  /** The certs and the attestation must already be staged in the registry's `CertManager` and `NitroValidator`. */
  registerTee(
    attestationTbs: Buffer,
    signature: Buffer,
    pubKeyX: Buffer32,
    pubKeyY: Buffer32,
    encPubKeyX: Buffer32,
    encPubKeyY: Buffer32,
    options: WriteOptions = {},
  ): Promise<ContractWriteResult> {
    return this.write(
      'registerTee',
      [
        `0x${attestationTbs.toString('hex')}`,
        `0x${signature.toString('hex')}`,
        pubKeyX.toString() as Hex,
        pubKeyY.toString() as Hex,
        encPubKeyX.toString() as Hex,
        encPubKeyY.toString() as Hex,
      ],
      options,
    );
  }

  private async certManagerContract(): Promise<
    GetContractReturnType<typeof CertManagerAbi, TeeRegistryContract['client']>
  > {
    this.certManager ??= getContract({
      address: await this.registry.read.TEE_CERT_MANAGER(),
      abi: CertManagerAbi,
      client: this.client,
    });
    return this.certManager;
  }

  private async nitroValidatorContract(): Promise<
    GetContractReturnType<typeof NitroValidatorAbi, TeeRegistryContract['client']>
  > {
    this.nitroValidator ??= getContract({
      address: await this.registry.read.TEE_NITRO_VALIDATOR(),
      abi: NitroValidatorAbi,
      client: this.client,
    });
    return this.nitroValidator;
  }

  private write<functionName extends ContractFunctionName<typeof TeeRegistryAbi, 'nonpayable'>>(
    functionName: functionName,
    args: ContractFunctionArgs<typeof TeeRegistryAbi, 'nonpayable', functionName>,
    options: WriteOptions,
  ): Promise<ContractWriteResult> {
    if (!('writeContract' in this.client) || !this.client.account) {
      throw new Error('TeeRegistryContract: this method requires a wallet client with an account');
    }
    return writeWithGasLimit(
      this.client,
      { address: this.address.toString(), abi: TeeRegistryAbi, functionName, args },
      options,
    );
  }
}
