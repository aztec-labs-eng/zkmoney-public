import type { InputMap } from '@aztec-foundation/noir-noir_js';
import { AztecAddress } from '@aztec-labs/stdlib/aztec-address';

import { secp256k1 } from '@oxide/resolver-lib/libsecp256k1.js';
import { Secp256k1Point } from '@oxide/resolver-lib/secp256k1_point.js';

import { describe, expect, it } from '@jest/globals';

import { buildResolutionNoirInput } from './noir_input.js';
import { generateWitness } from './witness.js';

// The native solver is the `noir-execute` binary from a noir release: ci-jest.yml installs it with
// scripts/install-noir-execute.sh and the resolver-service image bakes it. Without this variable the native leg skips.
const noirExecuteBinaryPath = process.env.OXIDE_TEST_NOIR_EXECUTE_BINARY_PATH;

const RESOLVER_PRIVATE_KEY = Buffer.alloc(32, 7);

function inputMap(resolverPrivateKey = RESOLVER_PRIVATE_KEY): InputMap {
  const userPrivateKey = Buffer.alloc(32, 9);
  return buildResolutionNoirInput({
    day: 20_000,
    nonce: 3,
    userPublicKey: Secp256k1Point.fromSec1(secp256k1.publicKeyCreate(userPrivateKey, false)),
    resolverPublicKey: Secp256k1Point.fromSec1(secp256k1.publicKeyCreate(RESOLVER_PRIVATE_KEY, false)),
    userL2Address: AztecAddress.fromStringUnsafe(`0x${'11'.repeat(32)}`),
    resolverPrivateKey,
  }) as InputMap;
}

describe('witness generation', () => {
  it('reports an unusable noir-execute binary rather than falling back to wasm', async () => {
    await expect(generateWitness(inputMap(), '/nonexistent/noir-execute')).rejects.toThrow(
      'could not run noir-execute',
    );
  });

  // /usr/bin/false exists on Linux and macOS, the platforms this suite runs on.
  it('reports a solver that exits without a witness rather than falling back to wasm', async () => {
    await expect(generateWitness(inputMap(), '/usr/bin/false')).rejects.toThrow('noir-execute exited with 1');
  });

  const itNative = noirExecuteBinaryPath ? it : it.skip;
  itNative('solves natively to the same witness as wasm, byte for byte', async () => {
    const inputs = inputMap();
    const [wasm, native] = await Promise.all([generateWitness(inputs), generateWitness(inputs, noirExecuteBinaryPath)]);
    expect(native.equals(wasm)).toBe(true);
  });

  // The pinned artifact carries a debug stub in place of the compiler's debug metadata (see repin.sh). With a stub
  // the solver cannot decode, a failed assertion ends in a panic (exit 101) instead of this report.
  itNative('reports a failed circuit assertion', async () => {
    const wrongResolverKey = Buffer.alloc(32, 8);
    await expect(generateWitness(inputMap(wrongResolverKey), noirExecuteBinaryPath)).rejects.toThrow(
      /noir-execute exited with 1: [\s\S]*Failed assertion/,
    );
  });
});
