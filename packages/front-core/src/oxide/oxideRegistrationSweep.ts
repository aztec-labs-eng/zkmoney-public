/**
 * The manual (self-relayer) registration sweep, behind the "Sweep manually" affordance a pending
 * registration deposit offers — the registration counterpart of a plain deposit's self-sweep.
 *
 * It builds the SAME deploy-and-sweep a relayer runs for the RegistrationSIPA, from the broadcast
 * payload the wallet already assembled (`registrationData` + consent/domain/terms proofs), naming
 * the user's own L1 address as the relayer so the deposit fee returns to them. The returned call is
 * submitted over the same L1 channel a plain deposit self-sweep uses; the on-chain registration fee
 * still comes out of the deposit — bypassing the relayer changes who submits, not what is charged.
 */
import { buildRegistrationSweepCall, type SipaSweepCall } from "@obsidion/sdk"
import type { Address } from "viem"
import type { RegistrationBroadcastPayload } from "./oxideRegistration"

/** The manifest surface a registration self-sweep binds to, beyond the payload's own deploy args. */
export interface RegistrationSweepManifest {
  sipaFactory: Address
  token: Address
  /** Overrides the canonical cross-chain Multicall3 deployment for an undeployed-SIPA deploy-and-sweep. */
  multicall3?: Address
}

/**
 * Assemble the registration self-sweep call from the broadcast payload. `relayer` is the user's L1
 * address (the sweep channel's target); `deployed` is a live `getCode` check on the SIPA — an
 * already-deployed clone is swept directly, an undeployed one deploy-and-swept through Multicall3.
 */
export function buildRegistrationSelfSweepCall(
  payload: Pick<
    RegistrationBroadcastPayload,
    | "sipaAddress"
    | "sipaArgs"
    | "registrationData"
    | "consentSig"
    | "bootstrap"
    | "domainAuth"
    | "signedTerms"
    | "r1Install"
  >,
  params: { deployed: boolean; relayer: Address; manifest: RegistrationSweepManifest },
): SipaSweepCall {
  return buildRegistrationSweepCall({
    deployed: params.deployed,
    sipaFactory: params.manifest.sipaFactory,
    sipa: payload.sipaAddress,
    deployArgs: payload.sipaArgs,
    registrationData: payload.registrationData,
    consentSig: payload.consentSig,
    bootstrap: payload.bootstrap,
    domainAuth: payload.domainAuth,
    signedTerms: payload.signedTerms,
    r1Install: payload.r1Install,
    token: params.manifest.token,
    relayer: params.relayer,
    multicall3: params.manifest.multicall3,
  })
}
