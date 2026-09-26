import { describe, it } from "vitest"
import { ContractService } from "../src/services/index.js"
import { createAztecNodeClient, createPXEClient } from "@aztec/aztec.js"
import { getInitialTestAccountsData } from "@aztec/accounts/testing"
import { sendEmptyTx } from "../src/index.js"
import { AZTEC_NODE_URL } from "@obsidion/core/constants"

const PXE_URL = AZTEC_NODE_URL
// const PXE_URL = "https://pxe.obsidion.xyz"
const pxe = createPXEClient(PXE_URL)

// pnpm test:sandbox scripts/advanceBlocks.test.ts

export async function fetchTokenBalance() {
  const acc = (await getDeployedTestAccountsWallets(pxe))[0]

  await sendEmptyTx(acc, pxe)
}

describe("Script", async () => {
  it("script", async () => {
    await fetchTokenBalance()
  })
})
