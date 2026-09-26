/**
 * ClaimFPC deterministic instantiation + the `refuel` tx's fee declaration.
 *
 * The address must be computable before the oxide L1 side exists (their skim pool deposits to it),
 * so the deploy is universal (zero deployer), the salt is a pinned versioned constant per network,
 * and the only constructor arg is the configure-password hash. Same (artifact, salt, hash) → same
 * address on every network.
 */
import { Fr } from "@aztec/aztec.js/fields"
import { Gas } from "@aztec/stdlib/gas"
import { poseidon2Hash } from "@aztec/foundation/crypto/poseidon"
import type { ContractArtifact } from "@aztec/stdlib/abi"
import {
  getContractInstanceFromInstantiationParams,
  type ContractInstanceWithAddress,
} from "@aztec/stdlib/contract"
import { claimFpcRefuelGas } from "@obsidion/contracts"
import { CLAIM_FPC_GAS_TABLE } from "./claimFpcGasTable.js"

/** TS mirror of the circuit's `password_hash_of`: the `str<31>` packed as one big-endian field
 * (FieldCompressedString), poseidon2-hashed. ASCII-only. */
export async function claimFpcPasswordHash(password: string): Promise<Fr> {
  const bytes = new TextEncoder().encode(password)
  if (bytes.length === 0) {
    throw new Error("ClaimFPC password must not be empty")
  }
  if (bytes.length > 31) {
    throw new Error(`ClaimFPC password must be at most 31 bytes, got ${bytes.length}`)
  }
  const padded = new Uint8Array(31)
  padded.set(bytes)
  const hex = Array.from(padded, (b) => b.toString(16).padStart(2, "0")).join("")
  return await poseidon2Hash([new Fr(BigInt(`0x${hex}`))])
}

/** The counterfactual ClaimFPC instance at the given salt: universal deploy (no deployer in the address
 * preimage), password hash as the only initializer arg. The salt is oxide's — they seed it and publish it
 * beside the address their FPCFunder deposits to. */
export async function getClaimFpcInstance(
  artifact: ContractArtifact,
  passwordHash: Fr,
  salt: Fr,
): Promise<ContractInstanceWithAddress> {
  return await getContractInstanceFromInstantiationParams(artifact, {
    salt,
    constructorArgs: [passwordHash],
  })
}

/**
 * The `fee` for a `refuel` send: the contract's own `REFUEL_OVERHEAD_GAS` declared exactly as the
 * limits, mirroring `claimFpcSponsoredFee` — the circuit bounds declared gas x fee-per-gas, so the
 * declaration must be the budget, and the wallet's priced fee-per-gas is the only variable.
 *
 * refuel is a fixed shape, so the artifact global is asserted equal to the measured gas table to
 * the gas (the same cross-check discipline as `deriveClaimFpcGasBudgets`): a re-measurement or a
 * contract change that moves the number fails loudly here instead of shipping a drifted cap.
 */
export function claimFpcRefuelFee(): { gasSettings: { gasLimits: Gas; teardownGasLimits: Gas } } {
  const gas = claimFpcRefuelGas()
  const measured = CLAIM_FPC_GAS_TABLE["refuel"]
  if (!measured || measured.daGas !== gas.daGas || measured.l2Gas !== gas.l2Gas) {
    throw new Error(
      `REFUEL_OVERHEAD_GAS (da=${gas.daGas}, l2=${gas.l2Gas}) does not match the measured gas ` +
        `table entry (da=${measured?.daGas}, l2=${measured?.l2Gas}) — re-run the sdk fpc suites ` +
        "with CLAIMFPC_GAS_REPORT=1 and pin the contract global to the regenerated table",
    )
  }
  return {
    gasSettings: {
      gasLimits: new Gas(gas.daGas, gas.l2Gas),
      teardownGasLimits: Gas.empty(),
    },
  }
}
