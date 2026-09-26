// Key for a node behind an API gateway, published once by the platform layer at boot
// (web-wallet from VITE_NODE_API_KEY) and read by
// every front-core node-RPC caller. It is a build-time value that already ships inside the
// client bundle, so it is deliberately NOT written to storage -- a rotated key then takes
// effect on the next launch rather than sticking in a persisted network record.
// Mirrors setActiveGenerationNode / setNoircGeneration.

let apiKey: string | undefined

export function setNodeApiKey(key: string | undefined): void {
  apiKey = key || undefined
}

export function getNodeApiKey(): string | undefined {
  return apiKey
}
