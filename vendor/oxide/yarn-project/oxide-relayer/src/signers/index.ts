import { Buffer32 } from '@aztec/foundation/buffer';

import { Wallet } from 'ethers';
import { readFile } from 'node:fs/promises';
import { createInterface } from 'node:readline/promises';
import { type Address, type Hex, nonceManager } from 'viem';
import { type PrivateKeyAccount, privateKeyToAccount } from 'viem/accounts';

import type { SignerConfig } from '../cli/config.js';

/** A local account ready for later transaction signing, plus the backend that produced it. */
export interface LoadedSigner {
  backend: 'env' | 'keystore';
  address: Address;
  account: PrivateKeyAccount;
}

/**
 * Load the configured signer backend.
 *
 * The caller should skip this entirely when `disableSubmission` is set, so those runs never decrypt
 * keystores or require private-key env vars.
 */
export async function loadSigner(config: SignerConfig, env: NodeJS.ProcessEnv = process.env): Promise<LoadedSigner> {
  switch (config.backend) {
    case 'env': {
      const account = loadEnvAccount(config.privateKeyEnvVar, env);
      return {
        backend: 'env',
        account,
        address: account.address,
      };
    }
    case 'keystore': {
      const account = await loadKeystoreAccount(config);
      return { backend: 'keystore', account, address: account.address };
    }
  }
}

function loadEnvAccount(envVar: string, env: NodeJS.ProcessEnv): PrivateKeyAccount {
  const raw = env[envVar];
  if (!raw) {
    throw new Error(`signer env backend requires ${envVar} to be set.`);
  }
  // Attach viem's nonce manager so pipelined sweeps in one slot get sequential nonces.
  return privateKeyToAccount(normalizePrivateKey(raw, envVar), { nonceManager });
}

async function loadKeystoreAccount(config: SignerConfig): Promise<PrivateKeyAccount> {
  if (!config.keystorePath) {
    throw new Error('keystore signer requires --keystore or OXIDE_RELAYER_KEYSTORE.');
  }
  const json = await readFile(config.keystorePath, 'utf8');
  const password = await loadKeystorePassword(config);
  const wallet = await Wallet.fromEncryptedJson(json, password);
  return privateKeyToAccount(normalizePrivateKey(wallet.privateKey, 'keystore private key'), { nonceManager });
}

async function loadKeystorePassword(config: SignerConfig): Promise<string> {
  if (config.keystorePassword !== undefined) {
    return config.keystorePassword;
  }
  if (config.keystorePasswordFile) {
    const passwordFile = await readFile(config.keystorePasswordFile, 'utf8');
    // Remove trailing newline from the password file data
    const password = passwordFile.replace(/\r?\n$/, '');
    return password;
  }
  if (!process.stdin.isTTY) {
    throw new Error('keystore signer requires --keystore-password-file when stdin is not interactive.');
  }

  const rl = createInterface({ input: process.stdin, output: process.stderr });
  try {
    return await rl.question('Keystore password: ');
  } finally {
    rl.close();
  }
}

function normalizePrivateKey(value: string, source: string): Hex {
  try {
    return Buffer32.fromString(value.trim()).toString() as Hex;
  } catch {
    throw new Error(`${source} must be a 32-byte hex private key.`);
  }
}
