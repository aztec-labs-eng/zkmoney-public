import { createPXEClient, waitForPXE } from "@aztec/aztec.js"
import { describe, it } from "vitest"
import { AZTEC_NODE_URL } from "@obsidion/core/constants"

const PXE_URL = AZTEC_NODE_URL
// const PXE_URL = "https://pxe.obsidion.xyz"
const pxe = createPXEClient(PXE_URL)

async function getPXEAndNodeInfo() {
  console.log("Waiting for PXE...")
  await waitForPXE(pxe)

  const pxeInfo = await pxe.getPXEInfo()
  if (!pxeInfo) {
    throw new Error("PXE not found")
  }

  console.log("pxeInfo: ", pxeInfo)

  console.log("Getting first block...")
  const nodeInfo = await pxe.getNodeInfo()
  if (!nodeInfo) {
    throw new Error("First block not found")
  }

  console.log("nodeInfo: ", nodeInfo)
}

describe("Script", async () => {
  it("script", async () => {
    await getPXEAndNodeInfo()
  })
})
