import { randomBytes } from 'node:crypto';
import { createRequire } from 'node:module';

const requireCjs = createRequire(import.meta.url);

// `bindings.js` fails loudly if the native addon is missing; the package main would silently
// fall back to a non-constant-time pure-JS implementation.
export const secp256k1: typeof import('secp256k1') = requireCjs('secp256k1/bindings.js');

// Blind libsecp256k1's internal computations against side-channel attacks.
secp256k1.contextRandomize(randomBytes(32));
