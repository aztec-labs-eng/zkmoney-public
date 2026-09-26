// The config contract every consumer shares: the profile schema, the fetch/resolve client, and
// the mapping into the ContractService snapshot. The service that SERVES these documents lives in
// packages/backend/config-service and imports this package like any other consumer.
export * from "./schema.js"
export * from "./client.js"
export * from "./toContractServiceConfig.js"
export * from "./walletProfile.js"
export * from "./artifactManifest.js"
