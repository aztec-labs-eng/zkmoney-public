import { type Hex, getAddress, isHex } from 'viem';
import { z } from 'zod';

export const hexSchema = z
  .string()
  .refine(s => isHex(s), 'must be a hex string')
  .transform(s => s as Hex);

export const bytes32Schema = z
  .string()
  .refine(s => isHex(s) && s.length === 66, 'must be a 32-byte hex string')
  .transform(s => s as Hex);

export const addressSchema = z
  .string()
  .refine(s => {
    try {
      getAddress(s);
      return true;
    } catch {
      return false;
    }
  }, 'must be an address')
  .transform(s => getAddress(s));

export const uintSchema = z
  .union([
    z.number().int().nonnegative(),
    z.string().regex(/^([0-9]+|0x[0-9a-fA-F]+)$/, 'must be a non-negative integer'),
  ])
  .transform(v => BigInt(v));
