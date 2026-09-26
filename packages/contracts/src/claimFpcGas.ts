/**
 * ClaimFPC's gas globals, read out of its compiled artifact.
 *
 * The contract declares them as `#[abi(...)]` globals (claim_fpc/src/main.nr): `fpc_gas` is the
 * entrypoint overhead charged once per sponsored batch, `fpc_refuel_gas` is what one `refuel` tx
 * declares, and `fpc_gate_gas` holds one entry per gate — what that gate's self-call adds to a
 * `subscribe`. They are the contract's numbers, not deploy inputs. Reading them here is what lets
 * the deploy config and the clients derive budgets against exactly what the circuit charges.
 */
import ClaimFPCContractArtifactJson from "./artifacts/target/claim_fpc/claim_fpc-ClaimFPC.json" with { type: "json" }

export interface ClaimFpcOverheadGas {
  daGas: number
  l2Gas: number
}

const FPC_GAS_TAG = "fpc_gas"
const FPC_REFUEL_GAS_TAG = "fpc_refuel_gas"
const FPC_GATE_GAS_TAG = "fpc_gate_gas"

interface AbiIntegerValue {
  kind: string
  value: string
}

interface AbiStructValue {
  kind: string
  fields: { name: string; value: AbiIntegerValue }[]
}

/** Each entry is `{ name: "<CONST_NAME>", value: <struct> }`. */
interface AbiGlobalEntry {
  name: string
  value: AbiStructValue
}

function integerField(tag: string, struct: AbiStructValue, name: string): number {
  const field = struct.fields?.find((f) => f.name === name)
  if (field?.value?.kind !== "integer") {
    throw new Error(
      `ClaimFPC artifact global "${tag}" has no integer field "${name}" — ` +
        "rebuild the contracts (pnpm build-contracts -c claim_fpc)",
    )
  }
  return Number(BigInt(`0x${field.value.value}`))
}

function gasGlobal(tag: string, name?: string): ClaimFpcOverheadGas {
  const outputs = (
    ClaimFPCContractArtifactJson as unknown as {
      outputs?: { globals?: Record<string, AbiGlobalEntry[]> }
    }
  ).outputs
  const entries = outputs?.globals?.[tag]
  const global = (name ? entries?.find((entry) => entry.name === name) : entries?.[0])?.value
  if (!global) {
    throw new Error(
      `ClaimFPC artifact exports no "${name ?? tag}" global — the artifact predates it; ` +
        "rebuild it with pnpm build-contracts -c claim_fpc",
    )
  }
  return { daGas: integerField(tag, global, "da_gas"), l2Gas: integerField(tag, global, "l2_gas") }
}

/** The gate globals, by the contract's name for each. */
export const CLAIM_FPC_GATE_GAS_GLOBALS = {
  nameClaim: "NAME_CLAIM_GATE_GAS",
  registration: "REGISTRATION_GATE_GAS",
  /** A rail entered by gift alone runs no gate. */
  none: null,
} as const

let cachedOverhead: ClaimFpcOverheadGas | undefined
let cachedRefuel: ClaimFpcOverheadGas | undefined

/** The gas ClaimFPC charges every sponsored batch before any whitelisted call. */
export function claimFpcOverheadGas(): ClaimFpcOverheadGas {
  return (cachedOverhead ??= gasGlobal(FPC_GAS_TAG))
}

/** The gas one `refuel` tx declares (the circuit caps its fee at these limits priced at the
 * config's fee-per-gas, or at the claimed amount if smaller). */
export function claimFpcRefuelGas(): ClaimFpcOverheadGas {
  return (cachedRefuel ??= gasGlobal(FPC_REFUEL_GAS_TAG))
}

/**
 * What one gate's self-call adds to a `subscribe`, on top of the entrypoint overhead. The contract
 * puts it in the `GateReceipt`, so this is the same number the circuit prices the batch cap with.
 */
export function claimFpcGateGas(
  gate: keyof typeof CLAIM_FPC_GATE_GAS_GLOBALS,
): ClaimFpcOverheadGas {
  const global = CLAIM_FPC_GATE_GAS_GLOBALS[gate]
  if (global === null) return { daGas: 0, l2Gas: 0 }
  return gasGlobal(FPC_GATE_GAS_TAG, global)
}
