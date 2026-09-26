import { decodeAppleJwt, decodeJwt } from "./utils.js"
import { Base64, Bytes } from "ox"
import { z } from "zod"
import { poseidon2Hash } from "@zkpassport/poseidon2"
import {
  bnToLimbStrArray,
  computeBarrettReductionParameter,
  splitInto120BitLimbs,
} from "./BigNumParamGen.js"

export type PublicKey = {
  kid: string
  n: string
  e: string
  limbs: {
    public_key_limbs: string[]
    public_key_redc_limbs: string[]
  }
  jwk_id?: `0x${string}`
}

export type OidcKeyRegistryInfo = {
  address: string
  chainId: number
  deploymentHash?: string
}

export const GOOGLE_OIDC_ISSUER = "https://accounts.google.com"
export const APPLE_OIDC_ISSUER = "https://appleid.apple.com"

/** Issuers whose JWKS we fetch/sync. Add here to support another OIDC provider. */
export const SUPPORTED_OIDC_ISSUERS = [GOOGLE_OIDC_ISSUER, APPLE_OIDC_ISSUER] as const

export class PublicKeyRegistry {
  /**
   * Compute correct Barrett reduction parameter for 2048-bit RSA (35 limbs of 120 bits)
   * Matches the updated noir_rsa v0.10.0 implementation
   * Barrett parameter is 2*NUM_BITS + OVERFLOW_BITS long
   */
  private computeBarrettRedcLimbs(modulus: bigint): string[] {
    const NUM_BITS = 2048
    // Compute Barrett reduction parameter
    const barrettParam = computeBarrettReductionParameter(modulus, NUM_BITS)
    const limbs = splitInto120BitLimbs(barrettParam, NUM_BITS)
    return limbs.map((limb) => "0x" + limb.toString(16))
  }

  public async getPublicKeyByJwt(jwt: string) {
    const decoded = decodeJwt(jwt)
    const publicKeys = await this.getPublicKeysByIssuer(decoded.payload.iss)
    const key = publicKeys.find((key) => key.kid === decoded.header.kid)
    if (!key) {
      throw new Error("Public key not found for jwt")
    }
    const jwk_id = await this.deriveJwkId(Base64.toBytes(key.n), Base64.toBytes(key.e))
    return {
      ...key,
      jwk_id,
    }
  }

  public async getPublicKeyByAppleJwt(jwt: string) {
    const decoded = decodeAppleJwt(jwt)
    const publicKeys = await this.getPublicKeysByIssuer(decoded.payload.iss)
    const key = publicKeys.find((key) => key.kid === decoded.header.kid)
    if (!key) {
      throw new Error("Apple public key not found for jwt")
    }
    const jwk_id = await this.deriveJwkId(Base64.toBytes(key.n), Base64.toBytes(key.e))
    return {
      ...key,
      jwk_id,
    }
  }

  // used in deployOidcKeyRegistry.ts
  public async deriveJwkId(n: Uint8Array, e: Uint8Array): Promise<`0x${string}`> {
    const publicKey = Bytes.toBigInt(n)
    const eBigInt = Bytes.toBigInt(e)
    const limbs = {
      public_key_limbs: bnToLimbStrArray(publicKey, 2048),
      public_key_redc_limbs: this.computeBarrettRedcLimbs(publicKey),
    }

    // Convert all limbs to bigints and concatenate with e
    const allLimbs: bigint[] = [
      ...limbs.public_key_limbs.map((x) => BigInt(x)),
      ...limbs.public_key_redc_limbs.map((x) => BigInt(x)),
      eBigInt,
    ]

    const hash = poseidon2Hash(allLimbs)
    return ("0x" + hash.toString(16).padStart(64, "0")) as `0x${string}`
  }

  public async getPublicKeys() {
    const keySets = await Promise.all(
      SUPPORTED_OIDC_ISSUERS.map((issuer) => this.getPublicKeysByIssuer(issuer)),
    )
    return keySets.flat()
  }

  /** OIDC discovery: resolve the issuer's `.well-known/openid-configuration` to its current `jwks_uri`. */
  public async getPublicKeysByIssuer(issuer: string): Promise<PublicKey[]> {
    const response = await fetch(`${issuer.replace(/\/$/, "")}/.well-known/openid-configuration`)
    const { jwks_uri } = z.object({ jwks_uri: z.string().url() }).parse(await response.json())
    return this.getPublicKeysByUrl(jwks_uri)
  }

  private async getPublicKeysByUrl(url: string): Promise<PublicKey[]> {
    const response = await fetch(url)
    const data = await response.json()
    const res = z
      .object({
        keys: z.array(
          z.object({
            kid: z.string(),
            n: z.string(),
            e: z.string(),
          }),
        ),
      })
      .parse(data)
    const keys = res.keys.map(async (key) => {
      const publicKey = Bytes.toBigInt(Base64.toBytes(key.n))
      const limbs = {
        public_key_limbs: bnToLimbStrArray(publicKey, 2048),
        public_key_redc_limbs: this.computeBarrettRedcLimbs(publicKey),
      }
      const jwk_id = await this.deriveJwkId(Base64.toBytes(key.n), Base64.toBytes(key.e))
      return {
        kid: key.kid,
        n: key.n,
        e: key.e,
        limbs,
        jwk_id,
      } as PublicKey
    })
    return await Promise.all(keys)
  }
}
