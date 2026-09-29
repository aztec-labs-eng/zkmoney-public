import { describe, expect, it } from '@jest/globals';
import { Wallet } from 'ethers';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { loadSigner } from './index.js';

const PRIVATE_KEY = `0x${'11'.repeat(32)}`;

describe('loadSigner', () => {
  it('loads an env private key signer', async () => {
    const signer = await loadSigner(
      { backend: 'env', privateKeyEnvVar: 'L1_PRIVATE_KEY' }, // gitleaks:allow
      { L1_PRIVATE_KEY: PRIVATE_KEY },
    );

    expect(signer.backend).toBe('env');
    expect(signer.address.toLowerCase()).toBe('0x19e7e376e7c213b7e7e7e46cc70a5dd086daff2a');
  });

  it('loads an encrypted JSON keystore signer', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'oxide-relayer-keystore-'));
    try {
      const wallet = new Wallet(PRIVATE_KEY);
      const keystorePath = path.join(dir, 'relayer.json');
      const passwordPath = path.join(dir, 'password');
      await writeFile(keystorePath, await wallet.encrypt('secret'), 'utf8');
      await writeFile(passwordPath, 'secret\n', 'utf8');

      const signer = await loadSigner({
        backend: 'keystore',
        privateKeyEnvVar: 'L1_PRIVATE_KEY', // gitleaks:allow
        keystorePath,
        keystorePasswordFile: passwordPath,
      });

      expect(signer.backend).toBe('keystore');
      expect(signer.address).toBe(wallet.address);
      expect(await readFile(passwordPath, 'utf8')).toBe('secret\n');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
