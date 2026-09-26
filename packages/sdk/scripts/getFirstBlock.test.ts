import { createAztecNodeClient } from "@aztec/aztec.js"
import { describe, it } from "vitest"

const node = createAztecNodeClient("https://https://aztec-testnet-fullnode.zkv.xyz")

// pnpm test:sandbox scripts/getFirstBlock.test.ts

async function getFirstBlock() {
  console.log("Getting first block...")
  const firstBlock = await node.getBlock(1)
  if (!firstBlock) {
    throw new Error("First block not found")
  }

  console.log("hash: ", (await firstBlock.hash()).toString())
}

describe("Script", async () => {
  it("script", async () => {
    await getFirstBlock()
  })
})
