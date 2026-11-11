/**
 * `rollupScanFloor` bounds log scans about a rollup by the earliest deployment the manifest lists on it.
 */
import { describe, expect, it, vi } from "vitest"
import type { OxideDeployment } from "@obsidion/core/oxide"
import type { PublicClient } from "viem"
import { rollupScanFloor } from "../../src/config/oxideTuple"
import { answered, testQuery } from "../support/query"

const client = { getBlockNumber: async () => 30_000n } as unknown as PublicClient

const deployment = (rollupVersion: string, ...blocks: (string | undefined)[]) =>
  ({
    rollupVersion,
    bridges: blocks.map((deployedAtBlock) => ({
      tuple: { rollupVersion, portal: "0xabc", deployedAtBlock },
    })),
  } as unknown as OxideDeployment)

const reads = (...deployments: OxideDeployment[]) => ({
  manifestDeployments: answered(deployments),
})

describe("rollupScanFloor", () => {
  it("is the first block of the earliest deployment on the rollup", async () => {
    const listed = reads(
      deployment("1", "20000", "12000"),
      deployment("2", "5000"),
      deployment("1", "15000"),
    )
    expect(await rollupScanFloor(listed, client, "1")).toBe(12_000n)
  })

  it("is undefined when the manifest lists no deployment on the rollup, or cannot be read", async () => {
    expect(await rollupScanFloor(reads(deployment("2", "5000")), client, "1")).toBeUndefined()

    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    const unread = testQuery()<[], OxideDeployment[]>("manifestDeployments", {
      load: async () => {
        throw new Error("oxide manifest HTTP 503")
      },
    })()
    expect(await rollupScanFloor({ manifestDeployments: unread }, client, "1")).toBeUndefined()
    warn.mockRestore()
  })

  it("fails with config.invalid when a deployment on the rollup names no start block", async () => {
    const thin = reads(deployment("1", "12000", undefined))
    await expect(rollupScanFloor(thin, client, "1")).rejects.toMatchObject({
      code: "config.invalid",
    })
  })
})
