/**
 * Regenerate the zkJWT fixture bound to a specific caller address.
 *
 * Pipeline:
 *   1. Build a Google-shaped JWT whose nonce = poseidon2(preimage, caller) using
 *      the repo's mocked JWKS (test/fixtures/jwks.json).
 *   2. Run it through `prepareJwtFromProvider` to produce a JwtInput.
 *   3. Solve the witness with noir_js over the pinned zkJWT artifact, and prove with
 *      bb.js UltraHonkBackend. Nothing is compiled.
 *   4. Pack {proof, public_inputs, vk_base64} into a fixture object.
 *
 * A test proves for its own caller as it runs: the proof stays in this process's memory, so no test writes anything
 * another reads. Only regenerateZkJwtFixture, run by hand, rewrites the committed test/fixtures/zkjwt/fixture.json.
 *
 * The helper installs a global fetch interceptor (setupJwtMocking) so that
 * PublicKeyRegistry resolves to the test JWKS — the same JWKS callers can then
 * register against the on-chain OidcKeyRegistry. Callers are responsible for
 * calling restoreFetch() in afterAll.
 */

import { readFileSync, writeFileSync, existsSync } from "fs"
import { createHash } from "crypto"
import { resolve, dirname } from "path"
import { fileURLToPath } from "url"
import { Barretenberg, UltraHonkBackend } from "@aztec-foundation/bb.js"
import { Noir } from "@aztec-foundation/noir-noir_js"
import { Fr } from "@aztec-labs/aztec.js/fields"
import {
  computeNonce,
  prepareJwtFromProvider,
  zkJwtInputMap,
  type JwtInput,
} from "../../../src/email/utils.js"
import { PublicKeyRegistry } from "../../../src/email/PublicKeyRegistry.js"
import { createJwtPayload, setupJwtMocking } from "./email.js"
import type { ZkJwtFixture } from "./zkJwtFixtureHelpers.js"

const __dirname = dirname(fileURLToPath(import.meta.url))
const SDK_ROOT = resolve(__dirname, "../../..")
/** Extracted from `packages/contracts/pinned/` by `pnpm build-contracts`. */
const CIRCUIT_PATH = resolve(SDK_ROOT, "../contracts/src/artifacts/target/zkJWT/zkJWT.json")
const FIXTURE_PATH = resolve(__dirname, "../../fixtures/zkjwt/fixture.json")
const ZKJWT_PUBLIC_INPUT_COUNT = 7
/** bb.js has hung in `Barretenberg.new` and `getVerificationKey`; a hung prove fails the test. */
const PROVE_TIMEOUT_MS = 10 * 60_000

function normalizeCaller(callerHex: string): string {
  // Canonicalise to 0x-prefixed 64-char lowercase so string compare is meaningful.
  return Fr.fromHexString(callerHex).toString()
}

/** The default `iat`: the start of today (UTC), well inside PaylinkEmail's freshness gate, so a day's proofs repeat. */
const todaysIat = () => Math.floor(Date.now() / 86_400_000) * 86_400

/** A proof's inputs, from which its nonce preimage derives: the same caller and iat give the same proof. */
const proofKey = (callerHex: string, iat: number) =>
  createHash("sha256")
    .update(`zkjwt:${normalizeCaller(callerHex)}:${iat}`)
    .digest()

/** This process's proofs by caller and iat, so a file claiming twice for one caller proves once. */
const proofs = new Map<string, Promise<ZkJwtFixture>>()

async function buildJwtInputForCaller(callerHex: string, iatSeconds: number): Promise<JwtInput> {
  const callerBigInt = BigInt(callerHex)
  // Derived from the inputs rather than random, so the same caller and iat give the same proof.
  const preimage = BigInt(`0x${proofKey(callerHex, iatSeconds).toString("hex")}`) % Fr.MODULUS
  const nonce = computeNonce(preimage, callerBigInt)

  const payload = createJwtPayload(undefined, nonce, {
    iat: iatSeconds,
  })
  // setupJwtMocking installs a global fetch interceptor for Google + Apple certs
  // using the repo's local JWKS fixture. Leaving it in place matches the existing
  // test flow (pkr.getPublicKeys() in beforeAll resolves to the same mocked keys).
  const { jwt } = setupJwtMocking(payload)

  const pkr = new PublicKeyRegistry()
  const { input } = await prepareJwtFromProvider(jwt, preimage, pkr, "google")
  return input
}

/**
 * Prove the zkJWT circuit for `callerHex` and pack proof/public_inputs/vk into
 * a fixture object.
 *
 * @param iatSeconds  JWT `iat` to embed (defaults to now). Backdate it past
 *                    PaylinkEmail's IAT_ALLOWED_DELAY to exercise the claim
 *                    freshness gate.
 * @param persist     When true the fixture is also written to the committed
 *                    fixture.json (regenerateZkJwtFixture, by hand). A test never
 *                    passes it.
 */
export async function generateZkJwtFixtureForCaller(
  callerHex: string,
  opts: { iatSeconds?: number; persist?: boolean } = {},
): Promise<ZkJwtFixture> {
  return proveForCaller(callerHex, opts)
}

async function proveForCaller(
  callerHex: string,
  { iatSeconds, persist = false }: { iatSeconds?: number; persist?: boolean },
): Promise<ZkJwtFixture> {
  const iat = iatSeconds ?? todaysIat()
  const key = `${normalizeCaller(callerHex)}:${iat}`
  if (!proofs.has(key)) proofs.set(key, proveWithDeadline(callerHex, iat))
  const fixture = await proofs.get(key)!
  if (persist) writeFileSync(FIXTURE_PATH, JSON.stringify(fixture, null, 2))
  return fixture
}

async function proveWithDeadline(callerHex: string, iat: number): Promise<ZkJwtFixture> {
  let timer: NodeJS.Timeout | undefined
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`zkJWT fixture proving took over ${PROVE_TIMEOUT_MS / 60_000} min`)),
      PROVE_TIMEOUT_MS,
    )
  })
  try {
    return await Promise.race([prove(callerHex, iat), deadline])
  } finally {
    clearTimeout(timer)
  }
}

async function prove(callerHex: string, iat: number): Promise<ZkJwtFixture> {
  const input = await buildJwtInputForCaller(callerHex, iat)
  const circuit = JSON.parse(readFileSync(CIRCUIT_PATH, "utf-8")) as ConstructorParameters<
    typeof Noir
  >[0]
  const { witness } = await new Noir(circuit).execute(zkJwtInputMap(input, callerHex))

  // The settings PaylinkEmail's `verify_proof_with_type` expects.
  const target = { verifierTarget: "noir-recursive" } as const
  const api = await Barretenberg.new({})
  let proof: Uint8Array, publicInputs: string[], vkBytes: Uint8Array
  try {
    const backend = new UltraHonkBackend(circuit.bytecode, api)
    vkBytes = await backend.getVerificationKey(target)
    ;({ proof, publicInputs } = await backend.generateProof(witness, target))
    if (!(await backend.verifyProof({ proof, publicInputs }, target)))
      throw new Error("zkJWT fixture proof did not verify")
  } finally {
    await api.destroy()
  }

  return {
    proof: Array.from(
      { length: proof.length / 32 },
      (_, i) => "0x" + Buffer.from(proof.subarray(i * 32, (i + 1) * 32)).toString("hex"),
    ),
    public_inputs: publicInputs,
    vk_base64: Buffer.from(vkBytes).toString("base64"),
  }
}

/** Regenerate the committed `test/fixtures/zkjwt/fixture.json` bound to `callerHex`: by hand, never from a test. */
export async function regenerateZkJwtFixture(callerHex: string): Promise<ZkJwtFixture> {
  return generateZkJwtFixtureForCaller(callerHex, { persist: true })
}

// A committed fixture's `iat` (public_inputs[4]) is frozen at generation time.
// PaylinkEmail::claim now rejects proofs whose iat is older than IAT_ALLOWED_DELAY
// (2 weeks), so a stale committed fixture fails every *successful*-claim test.
// Regenerate once the fixture ages past this threshold — kept well under the
// 2-week gate to leave margin for the sandbox clock drift + test-run duration.
const FIXTURE_MAX_AGE_SECONDS = 7 * 24 * 60 * 60

/**
 * Returns a fixture whose `public_inputs[0]` equals `callerHex` AND whose `iat`
 * is fresh enough to pass PaylinkEmail's on-chain freshness gate: the committed
 * fixture when it is one, else a proof made now (proveForCaller).
 */
export async function ensureZkJwtFixtureForCaller(callerHex: string): Promise<ZkJwtFixture> {
  return ensureUnlocked(callerHex)
}

async function ensureUnlocked(callerHex: string): Promise<ZkJwtFixture> {
  const want = normalizeCaller(callerHex)
  if (existsSync(FIXTURE_PATH)) {
    const existing = JSON.parse(readFileSync(FIXTURE_PATH, "utf-8")) as ZkJwtFixture
    if (existing.public_inputs.length !== ZKJWT_PUBLIC_INPUT_COUNT) {
      console.log(
        `[zkJWT fixture] public input layout changed (have=${existing.public_inputs.length}, want=${ZKJWT_PUBLIC_INPUT_COUNT}); regenerating`,
      )
      return proveForCaller(callerHex, {})
    }
    const have = normalizeCaller(existing.public_inputs[0]!)
    const iat = Number(BigInt(existing.public_inputs[4]!))
    const ageSeconds = Math.floor(Date.now() / 1000) - iat
    if (have === want && ageSeconds < FIXTURE_MAX_AGE_SECONDS) return existing
    if (have !== want) {
      console.log(`[zkJWT fixture] caller mismatch (have=${have}, want=${want}); regenerating`)
    } else {
      console.log(
        `[zkJWT fixture] iat stale (age=${ageSeconds}s >= ${FIXTURE_MAX_AGE_SECONDS}s); regenerating`,
      )
    }
  } else {
    console.log(`[zkJWT fixture] no fixture on disk; generating for ${want}`)
  }
  return proveForCaller(callerHex, {})
}
