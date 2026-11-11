// @vitest-environment node
/** A retired rollup's major: a source node that cannot answer fails the read, so it reads again. */
import { describe, expect, it } from "vitest"
import { retiredRollupMajor } from "../../src/platform/sourceGeneration"

const config = {
  nodeUrl: "https://v6.rpc.example",
  sourceRollups: [{ nodeUrl: "https://v6r.rpc.example" }, { nodeUrl: "https://v5r.rpc.example" }],
} as never

type Identity = { major: string; rollupAddress: string }
const nodes = (answers: Record<string, Identity | Error>) => async (url: string) => {
  const answer = answers[url]
  if (!answer || answer instanceof Error) throw answer ?? new Error(`no node at ${url}`)
  return answer
}
const ACTIVE = { major: "6", rollupAddress: "0x6000" }

describe("retiredRollupMajor", () => {
  it("rejects when a source node does not answer and no other names the rollup", async () => {
    const identityOf = nodes({
      "https://v6.rpc.example": ACTIVE,
      "https://v6r.rpc.example": { major: "6", rollupAddress: "0x6666" },
      "https://v5r.rpc.example": new Error("down"),
    })
    await expect(retiredRollupMajor(config, "0x5555", identityOf)).rejects.toMatchObject({
      name: "WalletError",
      code: "unknown",
      detail: "down",
    })
  })

  it("names the major once another source node names the rollup, whatever one fails", async () => {
    const identityOf = nodes({
      "https://v6.rpc.example": ACTIVE,
      "https://v6r.rpc.example": new Error("down"),
      "https://v5r.rpc.example": { major: "5", rollupAddress: "0x5555" },
    })
    await expect(retiredRollupMajor(config, "0x5555", identityOf)).resolves.toBe("5")
  })

  it("names nothing for a rollup every source node answers without", async () => {
    const identityOf = nodes({
      "https://v6.rpc.example": ACTIVE,
      "https://v6r.rpc.example": { major: "6", rollupAddress: "0x6666" },
      "https://v5r.rpc.example": { major: "5", rollupAddress: "0x5555" },
    })
    await expect(retiredRollupMajor(config, "0x7777", identityOf)).resolves.toBeUndefined()
    await expect(retiredRollupMajor(config, "0x6666", identityOf)).resolves.toBeUndefined()
  })
})
