import { createAztecNodeClient } from "@aztec/aztec.js/node"
import { AztecAddress } from "@aztec/stdlib/aztec-address"
import { describe, it } from "vitest"
import { poseidon2Hash } from "@aztec/foundation/crypto/poseidon"
import { Fr } from "@aztec/foundation/curves/bn254"
import { TESTNET_NODE_URL } from "@obsidion/core/constants"
// pnpm test:sandbox scripts/getContractClass.test.ts

const node = createAztecNodeClient(TESTNET_NODE_URL)

describe("Script", async () => {
  it("get webauthnModule on-chain class id", async () => {
    const address = AztecAddress.fromStringUnsafe(
      "0x13fa945a048fea6d6985476f4c31ba08d11250352793466cf662fab2c83c050b",
    )

    const instance = await node.getContract(address)
    if (!instance) {
      throw new Error("Contract not found")
    }

    console.log("instance: ", instance)
    console.log("currentContractClassId: ", instance.currentContractClassId.toString())
    console.log("originalContractClassId: ", instance.originalContractClassId.toString())
  })

  it("poseidon2Hash reference values (WASM bb.js)", async () => {
    const r1 = await poseidon2Hash([new Fr(4), new Fr(8)])
    console.log("poseidon2Hash([4, 8]) =", r1.toString())

    const r2 = await poseidon2Hash([])
    console.log("poseidon2Hash([]) =", r2.toString())

    const r3 = await poseidon2Hash([Fr.ZERO])
    console.log("poseidon2Hash([0]) =", r3.toString())

    const r4 = await poseidon2Hash([new Fr(1), new Fr(2), new Fr(3)])
    console.log("poseidon2Hash([1,2,3]) =", r4.toString())
  })
})
