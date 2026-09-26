// barrett.ts
// Corrected to match noir-bignum-paramgen / noir-bignum expectations for RSA moduli:
// - Barrett μ uses overflow bits = 6
// - All limbs are little-endian (least-significant limb first), as in noir-bignum-paramgen

export const LIMB_BITS = 120n

/**
 * Compute the Barrett reduction parameter μ for a modulus n.
 *
 * μ = floor( 2^(2*numBits + overflowBits) / n )
 *
 * NOTE: overflowBits should match noir-bignum implementation (currently 6 for RSA use in your context).
 */
export function computeBarrettReductionParameter(
  modulus: bigint,
  numBits?: number,
  overflowBits: bigint = 6n,
): bigint {
  if (modulus <= 0n) throw new Error("modulus must be positive")

  const actualBits = modulus.toString(2).length

  const k = numBits ?? actualBits
  if (actualBits > k) {
    throw new Error(`Given numBits (${k}) is too small for modulus bitlength (${actualBits})`)
  }

  const exponent = 2n * BigInt(k) + overflowBits
  const multiplicand = 1n << exponent

  return multiplicand / modulus
}

/**
 * Split an integer into 120-bit limbs (little-endian).
 * @param input BigInt to split
 * @param numBits controls limb count: ceil(numBits / 120)
 */
export function splitInto120BitLimbs(input: bigint, numBits: number): bigint[] {
  if (numBits <= 0) throw new Error("numBits must be > 0")

  const numLimbs = Math.floor(numBits / 120) + (numBits % 120 !== 0 ? 1 : 0)
  const mask = (1n << LIMB_BITS) - 1n

  const limbs: bigint[] = []
  let x = input

  for (let i = 0; i < numLimbs; i++) {
    const slice = x & mask
    x >>= LIMB_BITS
    limbs.push(slice)
  }

  return limbs
}

/**
 * Convert a BigInt into a fixed number of 120-bit limb hex strings (little-endian).
 * This is what you want for modulus limbs: ceil(numBits / 120) of them.
 */
export function bnToLimbStrArray(input: bigint | string, numBits?: number): string[] {
  const bn = toBigInt(input)
  const actualBits = bn.toString(2).length

  const k = numBits ?? actualBits
  if (actualBits > k) {
    throw new Error(`Given numBits (${k}) is too small for value bitlength (${actualBits})`)
  }

  const limbs = splitInto120BitLimbs(bn, k)
  return limbs.map(to0xHexEvenLength)
}

/* ---------------- helpers ---------------- */

function toBigInt(input: bigint | string): bigint {
  if (typeof input === "bigint") return input

  const cleanHex = input.toLowerCase().startsWith("0x") ? input.slice(2) : input
  if (!/^[0-9a-f]+$/i.test(cleanHex)) throw new Error("Invalid hexadecimal string")
  if (cleanHex.length === 0) throw new Error("Empty hexadecimal string")

  return BigInt("0x" + cleanHex)
}

function to0xHexEvenLength(x: bigint): string {
  let hex = x.toString(16)
  if (hex.length % 2 !== 0) hex = "0" + hex
  return "0x" + hex
}
