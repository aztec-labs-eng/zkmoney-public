#!/usr/bin/env node
/**
 * zkJWT standalone circuit: compile, witness, and (optionally) UltraHonk proof + VK.
 *
 * Inputs: uses existing Prover.toml in packages/contracts/circuits/zkJWT/.
 *
 * Usage (from repo root or packages/sdk):
 *   node packages/sdk/scripts/jwt/generate-zkjwt-proof.mjs
 *   node packages/sdk/scripts/jwt/generate-zkjwt-proof.mjs --prove
 *
 * Outputs:
 *   target/zkJWT.json              — compiled bytecode (nargo compile)
 *   target/zkJWT.gz                — witness (nargo execute)
 *   target/vk/vk                   — verification key (binary, N × 32 bytes)
 *   target/proof/proof.json        — { proof: string[] hex }
 *   target/proof/public_inputs.json — { public_inputs: string[] hex }
 *
 * Proving goes through @aztec/bb.js UltraHonkBackend (msgpack FFI). The `bb` CLI's on-disk proof serializer in
 * 4.3.0-nightly.20260421 trips `field_conversion.hpp` bigfield-limb asserts
 * for these circuits; the direct bbapi path returns raw field bytes and works.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs"
import { join, dirname } from "path"
import { fileURLToPath } from "url"
import { execSync } from "child_process"
import { Barretenberg, UltraHonkBackend } from "@aztec/bb.js"

const __dirname = dirname(fileURLToPath(import.meta.url))
const CIRCUIT_DIR = join(__dirname, "../../../contracts/circuits/zkJWT")
const PACKAGE_NAME = "zkJWT"

const NARGO = process.env.NARGO ?? "nargo"

function uint8ToHex(arr) {
  let hex = "0x"
  for (let i = 0; i < arr.length; i++) {
    hex += arr[i].toString(16).padStart(2, "0")
  }
  return hex
}

async function proveViaBbjs(circuitName, targetDir) {
  const bytecodeFile = join(targetDir, `${circuitName}.json`)
  const witnessFile = join(targetDir, `${circuitName}.gz`)
  const vkDir = join(targetDir, "vk")
  const proofDir = join(targetDir, "proof")
  mkdirSync(vkDir, { recursive: true })
  mkdirSync(proofDir, { recursive: true })

  const acir = JSON.parse(readFileSync(bytecodeFile, "utf-8"))
  const bytecode = acir.bytecode
  const compressedWitness = readFileSync(witnessFile)

  // ultra_honk_settings: poseidon2 + ZK + no IPA.
  const api = await Barretenberg.new({})
  const backend = new UltraHonkBackend(bytecode, api)
  try {
    console.log(`Computing VK via bb.js UltraHonkBackend...`)
    const vkBytes = await backend.getVerificationKey({ verifierTarget: "noir-recursive" })
    writeFileSync(join(vkDir, "vk"), Buffer.from(vkBytes))
    console.log(`VK written: ${join(vkDir, "vk")} (${vkBytes.length} bytes)`)

    console.log(`Proving via bb.js UltraHonkBackend...`)
    const { proof, publicInputs } = await backend.generateProof(compressedWitness, {
      verifierTarget: "noir-recursive",
    })

    const proofHex = []
    for (let i = 0; i < proof.length; i += 32) {
      proofHex.push(uint8ToHex(proof.subarray(i, i + 32)))
    }
    writeFileSync(
      join(proofDir, "proof.json"),
      JSON.stringify({ proof: proofHex }, null, 2),
    )
    writeFileSync(
      join(proofDir, "public_inputs.json"),
      JSON.stringify({ public_inputs: publicInputs }, null, 2),
    )
    console.log(
      `Proof written: ${proofDir}/proof.json (${proofHex.length} fields, ${publicInputs.length} public inputs)`,
    )

    console.log(`Verifying proof via bb.js UltraHonkBackend...`)
    const verified = await backend.verifyProof(
      { proof, publicInputs },
      { verifierTarget: "noir-recursive" },
    )
    if (!verified) throw new Error("Proof did not verify")
    console.log(`Proof verified.`)

    return { vkDir, proofDir }
  } finally {
    await api.destroy().catch(() => {})
  }
}

async function main() {
  const prove = process.argv.includes("--prove")

  if (!existsSync(CIRCUIT_DIR)) {
    console.error(`Circuit directory not found: ${CIRCUIT_DIR}`)
    process.exit(1)
  }

  const proverToml = join(CIRCUIT_DIR, "Prover.toml")
  if (!existsSync(proverToml)) {
    console.error(`Missing ${proverToml}`)
    process.exit(1)
  }

  const targetDir = join(CIRCUIT_DIR, "target")
  mkdirSync(targetDir, { recursive: true })

  console.log(`Circuit: ${CIRCUIT_DIR}`)
  console.log(`Mode: compile + execute${prove ? " + prove + verify (bb.js)" : ""}\n`)

  console.log(`nargo compile… (${NARGO})`)
  execSync(`${NARGO} compile`, { cwd: CIRCUIT_DIR, stdio: "inherit", timeout: 600_000 })

  console.log(`\nnargo execute… (${NARGO})`)
  execSync(`${NARGO} execute`, { cwd: CIRCUIT_DIR, stdio: "inherit", timeout: 600_000 })

  if (!prove) {
    console.log(`\nWitness: ${join(targetDir, `${PACKAGE_NAME}.gz`)}`)
    console.log("Re-run with --prove to write VK + proof + public_inputs.json")
    return
  }

  const { vkDir, proofDir } = await proveViaBbjs(PACKAGE_NAME, targetDir)

  console.log("\nDone.")
  console.log(`  VK:            ${vkDir}/vk`)
  console.log(`  Proof:         ${proofDir}/proof.json`)
  console.log(`  Public inputs: ${proofDir}/public_inputs.json`)
}

try {
  await main()
} catch (e) {
  console.error(e)
  process.exit(1)
}
