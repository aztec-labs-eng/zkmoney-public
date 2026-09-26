import { describe, it } from "vitest"
import { AztecAddress } from "@aztec/stdlib/aztec-address"
import { createAztecNodeClient } from "@aztec/aztec.js/node"
import { computeFeePayerBalanceStorageSlot } from "@aztec/protocol-contracts/fee-juice"
import { TESTNET_NODE_URL } from "../src/utils/constants.js"

const TARGET_ADDRESS = "0x15b7a9a3d3685e053bffec6bd35dfeb4beb2616831a8e93b65c0493bcb5b4138"
// const TARGET_ADDRESS = "0x130810ea9be9951301a21f48fc4ab316ee7bf26039f71726e69b9acb4951f0dc"

const node = createAztecNodeClient(TESTNET_NODE_URL)

// pnpm test:sandbox scripts/fetchFeeJuiceBalance.live.test.ts

export async function fetchFeeJuiceBalance() {
  const target = AztecAddress.fromStringUnsafe(TARGET_ADDRESS)

  const protocolAddresses = await node.getProtocolContractAddresses()
  const feeJuiceAddress = protocolAddresses.feeJuice
  console.log("FeeJuice contract address:", feeJuiceAddress.toString())

  const storageSlot = await computeFeePayerBalanceStorageSlot(target)
  const balance = await node.getPublicStorageAt("latest", feeJuiceAddress, storageSlot)

  console.log("Fee Juice balance:", balance.toBigInt())
}

describe("Script", async () => {
  it("fetch fee juice balance", async () => {
    await fetchFeeJuiceBalance()
  }, 30_000)
})
