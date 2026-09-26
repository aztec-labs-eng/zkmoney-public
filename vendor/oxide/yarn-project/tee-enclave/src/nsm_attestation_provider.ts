import type { AttestationProvider } from '@oxide/oxide-lib/attestation_provider.js';

import { spawn } from 'node:child_process';

const NSM_ATTEST_BIN = process.env.NSM_ATTEST_BIN ?? '/usr/bin/nsm-attest';

/**
 * Attestation provider: shells out to the Rust helper that talks /dev/nsm via aws-nitro-enclaves-nsm-api and prints the
 * COSE_Sign1 document on stdout. The helper accepts the user_data hex on stdin.
 */
export class NsmAttestationProvider implements AttestationProvider {
  constructor(private readonly bin: string = NSM_ATTEST_BIN) {}

  attest(userData: Buffer): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      const proc = spawn(this.bin, [], { stdio: ['pipe', 'pipe', 'pipe'] });
      const chunks: Buffer[] = [];
      const errChunks: Buffer[] = [];
      proc.stdout.on('data', (c: Buffer) => chunks.push(c));
      proc.stderr.on('data', (c: Buffer) => errChunks.push(c));
      proc.on('error', reject);
      proc.on('close', code => {
        if (code !== 0) {
          reject(new Error(`nsm-attest exited ${code}: ${Buffer.concat(errChunks).toString('utf8')}`));
          return;
        }
        resolve(Buffer.concat(chunks));
      });
      // The C helper reads user_data as raw bytes from stdin (not hex).
      proc.stdin.write(userData);
      proc.stdin.end();
    });
  }
}
