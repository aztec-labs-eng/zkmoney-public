// @vitest-environment node
/** The copied report carries the error and where it happened, one fact per line. */
import { afterEach, describe, expect, it, vi } from "vitest"
import { copyErrorReport } from "../../src/errors/shareErrorReport"
import { defaultConfig } from "../support/page"
afterEach(() => vi.unstubAllGlobals())

async function copied(payload: Parameters<typeof copyErrorReport>[0]): Promise<string[]> {
  const writeText = vi.fn(async (_text: string) => {})
  vi.stubGlobal("navigator", { clipboard: { writeText } })
  await copyErrorReport(payload, defaultConfig.network)
  expect(writeText).toHaveBeenCalledOnce()
  return writeText.mock.calls[0]![0].split("\n")
}

describe("copyErrorReport", () => {
  it("writes the title, message, detail, context and network", async () => {
    const lines = await copied({ title: "T1", message: "M1", detail: "D1", context: "C1" })
    for (const value of ["T1", "M1", "D1", "C1", defaultConfig.network])
      expect(lines.filter((line) => line.endsWith(value))).toHaveLength(1)
    expect(lines).toHaveLength(7)
  })

  it("leaves out the lines it has no value for", async () => {
    const lines = await copied({ title: "T1", message: "M1" })
    expect(lines).toHaveLength(5)
    expect(lines.some((line) => line.endsWith("undefined"))).toBe(false)
  })
})
