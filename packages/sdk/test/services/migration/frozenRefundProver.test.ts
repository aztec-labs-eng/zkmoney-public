import { expect, it } from "vitest"
import { EthAddress } from "@aztec-labs/aztec.js/addresses"
import { FrozenRefundMigrationRuntime } from "../../../src/services/migration/FrozenRefundMigrationRuntime.js"

it("starts the host's prover before it reads or proves a refund", async () => {
  const address = EthAddress.fromString("0x00000000000000000000000000000000000000bb")
  const runtime = new FrozenRefundMigrationRuntime({
    portal: { address },
    token: { address },
    owner: { address },
    executor: address,
    tipRecipient: address,
    startProver: async () => {
      throw new Error("the prover did not start")
    },
  } as never)
  await expect(
    runtime.build(
      { kind: "note", ids: ["0x01"] },
      "0x00000000000000000000000000000000000000aa",
      0n,
    ),
  ).rejects.toThrow("the prover did not start")
})
