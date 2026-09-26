// Contract artifacts
export * from "./artifacts/index.js"

// ClaimFPC's overhead gas, read from its artifact's `#[abi(fpc_gas)]` global
export * from "./claimFpcGas.js"

// ContractService — the services barrel re-exports @obsidion/core/types and
// /constants for backward compatibility, so Network, ContractName,
// FPCPaymentType, DEFAULT_CONTRACTS, etc. all stay reachable through
// @obsidion/contracts.
export * from "./services/index.js"
