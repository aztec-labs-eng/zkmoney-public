import type { TokenService } from "@obsidion/sdk"

// The canonical generation's TokenService constructor. The send/withdraw TEE
// dispatch pipeline is protocol-versioned end-to-end (offchain-effect layout,
// ancestry-hint node APIs, TEE attestation format), so a v4-canonical device
// must run the v4-origin sdk's TokenService — the v5 pipeline calls node
// APIs a 4.3.0 node doesn't serve and produces attestations the v4 enclave
// won't sign. Registered by the platform layer's v4 boot path, unset on
// v5 / single-generation devices.
export interface TokenServiceDeps {
  wallet: unknown
  account: unknown
  relayerUrl?: string
  relayerHeaders?: Record<string, string>
}

export type TokenServiceFactory = (deps: TokenServiceDeps) => Promise<TokenService>

let factory: TokenServiceFactory | undefined

export function setTokenServiceFactory(f: TokenServiceFactory | undefined): void {
  factory = f
}

export function getTokenServiceFactory(): TokenServiceFactory | undefined {
  return factory
}
