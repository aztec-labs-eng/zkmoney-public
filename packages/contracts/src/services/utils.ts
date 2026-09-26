import { ContractArtifact } from "@aztec/stdlib/abi"
import { loadContractArtifact } from "@aztec/stdlib/abi"
import { NoirCompiledContract } from "@aztec/stdlib/noir"
import type { AztecAddress } from "@aztec/stdlib/aztec-address"
import { DEFAULT_CONTRACTS } from "@obsidion/core/constants"
import type { ContractServiceOptions, ContractName } from "@obsidion/core/types"

// Artifacts are multi-MB JSON blobs, loaded through the wrapper modules in
// ../artifacts/lazy/ so each becomes its own lazily-fetched chunk under Vite and only
// the contracts a session touches ever load. The indirection is load-bearing: bundlers
// rewrite a plain dynamic import of a JS module, but leave a dynamic import that
// carries `with { type: "json" }` untouched — and Node requires that attribute for
// JSON. The wrapper holds the attribute on a STATIC import (fine everywhere) and the
// table imports the wrapper without attributes.
const HARDCODED_ARTIFACT_IMPORTS: Partial<
  Record<ContractName, () => Promise<{ default: unknown }>>
> = {
  [DEFAULT_CONTRACTS.oidcKeyRegistry]: () => import("../artifacts/lazy/oidc_key_registry.js"),
  [DEFAULT_CONTRACTS.sponsorFPC]: () => import("../artifacts/lazy/sponsor_fpc.js"),
  [DEFAULT_CONTRACTS.oxideToken]: () => import("../artifacts/lazy/oxide_token_contract.js"),
  [DEFAULT_CONTRACTS.obsidionAccountAlpha]: () => import("../artifacts/lazy/alpha_account.js"),
  [DEFAULT_CONTRACTS.obsidionAccountAlphaTest]: () =>
    import("../artifacts/lazy/alpha_account_test.js"),
  [DEFAULT_CONTRACTS.paylinkDirect]: () => import("../artifacts/lazy/paylink_direct.js"),
  [DEFAULT_CONTRACTS.paylinkEmail]: () => import("../artifacts/lazy/paylink_email.js"),
  [DEFAULT_CONTRACTS.passwordFPC]: () => import("../artifacts/lazy/password_fpc.js"),
  [DEFAULT_CONTRACTS.claimFpc]: () => import("../artifacts/lazy/claim_fpc.js"),
}

export const isContractArtifact = (obj: any): obj is ContractArtifact => {
  return obj && typeof obj === "object" && "functions" in obj && "name" in obj
}

/**
 * Register a contract class + instance in PXE across both PXE generations:
 * the v5 PXE takes the bare instance after a separate registerContractClass,
 * the v4 PXE takes one { instance, artifact } call. Duck-typed (retry, then
 * rethrow the original error) rather than generation-flagged so it keeps
 * working across a runtime cutover flip.
 *
 * Skips work the PXE already has: registerContractClass recomputes the full
 * contract class (artifact hash + per-function VK hashing) on EVERY call
 * before its dedup cache can hit, so re-registering a known class costs tens
 * of ms per call. The class check keys off the instance's class id — no
 * hashing needed — and falls through to full registration on any miss or on
 * a PXE that doesn't expose the getters.
 */
// Loose shape: the two PXE generations disagree on registerContract's arg
// and on which getters exist.
export type CrossGenerationPXE = {
  registerContractClass(artifact: ContractArtifact): Promise<unknown>
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  registerContract(contract: any): Promise<unknown>
  getContractArtifact?(classId: unknown): Promise<unknown>
  getContractInstance?(address: unknown): Promise<unknown>
}

export const registerContractInPXE = async (
  pxe: CrossGenerationPXE,
  instance: unknown,
  artifact: ContractArtifact,
): Promise<void> => {
  const inst = instance as {
    address?: unknown
    currentContractClassId?: unknown
    originalContractClassId?: unknown
  }
  const classId = inst?.currentContractClassId ?? inst?.originalContractClassId

  let classKnown = false
  if (classId && typeof pxe.getContractArtifact === "function") {
    classKnown = !!(await pxe.getContractArtifact(classId).catch(() => undefined))
  }
  if (classKnown && inst?.address && typeof pxe.getContractInstance === "function") {
    const registered = await pxe.getContractInstance(inst.address).catch(() => undefined)
    if (registered) return
  }

  if (!classKnown) {
    await pxe.registerContractClass(artifact)
  }
  try {
    await pxe.registerContract(instance)
  } catch (err) {
    try {
      await pxe.registerContract({ instance, artifact })
    } catch {
      throw err
    }
  }
}

/**
 * Idempotent PXE registration for an on-chain contract. When the PXE already
 * has the instance and its class artifact this returns without the node
 * round-trip and without invoking `getArtifact` — so hot paths (fee rails
 * registering their FPC per transaction) pay nothing after the first call.
 */
export const ensureContractRegisteredInPXE = async (
  pxe: CrossGenerationPXE,
  node: { getContract(address: AztecAddress): Promise<unknown> },
  address: AztecAddress,
  getArtifact: () => Promise<ContractArtifact>,
): Promise<void> => {
  if (
    typeof pxe.getContractInstance === "function" &&
    typeof pxe.getContractArtifact === "function"
  ) {
    const existing = (await pxe.getContractInstance(address).catch(() => undefined)) as
      | { originalContractClassId?: unknown }
      | undefined
    if (
      existing?.originalContractClassId &&
      (await pxe.getContractArtifact(existing.originalContractClassId).catch(() => undefined))
    ) {
      return
    }
  }
  const instance = await node.getContract(address)
  if (!instance) throw new Error(`Contract not found on-chain at ${address}`)
  await registerContractInPXE(pxe, instance, await getArtifact())
}

export const getHardcodedArtifact = async (
  contract: ContractName,
  options?: ContractServiceOptions,
) => {
  // Generation seam: the lazy table below is this branch's compilation; a
  // dual-stack app injects the canonical generation's artifact instead.
  const override = options?.resolveGenerationArtifact?.(contract)
  if (override) {
    return loadContractArtifact(override as NoirCompiledContract)
  }

  const importArtifact = HARDCODED_ARTIFACT_IMPORTS[contract]
  if (!importArtifact) {
    // Without this, loadContractArtifact(null) dies far away with an opaque
    // "Cannot read properties of null (reading 'name')" — name the contract
    // instead. (Historic trap: "USDC" stopped being a ContractName when the
    // legacy token identity was removed; the token artifact is oxideToken.)
    throw new Error(
      `No hardcoded artifact for contract "${contract}" — is it a valid ContractName?`,
    )
  }
  return loadContractArtifact((await importArtifact()).default as NoirCompiledContract)
}

/**
 * Loads the simulated stub artifact for `ObsidionAccountAlpha`. Cached
 * once per process. The wallet uses this during kernelless simulation
 * to install a `currentContractClassId` override on the user's account
 * via `SimulationOverrides`.
 *
 * Intentionally NOT routed through `DEFAULT_CONTRACTS` / `ContractService`:
 * the stub has no on-chain address and is never deployed -- it only
 * exists in PXE's class registry to satisfy the override dispatch path.
 */
let _cachedSimulatedAlphaAccountArtifact: Promise<ContractArtifact> | null = null

export const getSimulatedAlphaAccountArtifact = (): Promise<ContractArtifact> => {
  _cachedSimulatedAlphaAccountArtifact ??= import(
    "../artifacts/lazy/alpha_account_simulated.js"
  ).then((m) => loadContractArtifact(m.default as unknown as NoirCompiledContract))
  return _cachedSimulatedAlphaAccountArtifact
}

/**
 * Loads the vendored oxide Broadcaster artifact. Cached once per process.
 *
 * Intentionally NOT routed through `DEFAULT_CONTRACTS` / `ContractService`:
 * the Broadcaster is oxide-deployed at the env-tuple's `l2Broadcaster`
 * address — never obsidion-deployed, never in the profile document. The PXE
 * registers it (instance from the node + this artifact) so the wallet can
 * broadcast L1 operations through it.
 */
let _cachedBroadcasterArtifact: Promise<ContractArtifact> | null = null

export const getBroadcasterArtifact = (): Promise<ContractArtifact> => {
  _cachedBroadcasterArtifact ??= import("../artifacts/lazy/broadcaster_contract.js").then((m) =>
    loadContractArtifact(m.default as unknown as NoirCompiledContract),
  )
  return _cachedBroadcasterArtifact
}
