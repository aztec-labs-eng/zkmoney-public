import type { createAztecNodeClient } from "@aztec-labs/aztec.js/node"

// The node client the wallet built at boot, so node-RPC callers reuse it rather than build
// another. Set once the wallet boots (the page wallet's build). Callers fall back / no-op when it
// is unset (pre-boot).
type GenerationNode = ReturnType<typeof createAztecNodeClient>

let activeNode: GenerationNode | undefined

export function setActiveGenerationNode(node: GenerationNode | undefined): void {
  activeNode = node
}

export function getActiveGenerationNode(): GenerationNode | undefined {
  return activeNode
}
