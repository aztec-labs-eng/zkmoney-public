// @vitest-environment node
/** The clipboard write: the async Clipboard API, else the selection copy, which can fail too. */
import { afterEach, describe, expect, it, vi } from "vitest"
import { writeClipboard } from "../../src/ui/hooks"

afterEach(() => vi.unstubAllGlobals())

/** A document whose selection copy answers with `copy`; the textarea it adds is returned. */
function selectionCopy(copy: () => boolean) {
  const area = { value: "", style: {}, setAttribute: vi.fn(), select: vi.fn(), remove: vi.fn() }
  vi.stubGlobal("document", {
    createElement: () => area,
    body: { appendChild: vi.fn() },
    execCommand: vi.fn(copy),
  })
  return area
}

describe("writeClipboard", () => {
  it("writes through the Clipboard API where it exists", async () => {
    const writeText = vi.fn(async (_text: string) => {})
    vi.stubGlobal("navigator", { clipboard: { writeText } })
    const area = selectionCopy(() => true)
    await expect(writeClipboard("0xabc")).resolves.toBe(true)
    expect(writeText).toHaveBeenCalledWith("0xabc")
    expect(area.select).not.toHaveBeenCalled()
  })

  it("falls back to the selection copy when the Clipboard API refuses", async () => {
    vi.stubGlobal("navigator", {
      clipboard: { writeText: async () => Promise.reject(new Error("denied")) },
    })
    const area = selectionCopy(() => true)
    await expect(writeClipboard("0xabc")).resolves.toBe(true)
    expect(area.value).toBe("0xabc")
    expect(area.remove).toHaveBeenCalledOnce()
  })

  it("reports a failed copy when the selection copy throws too, and removes its textarea", async () => {
    vi.stubGlobal("navigator", {})
    const area = selectionCopy(() => {
      throw new Error("unsupported")
    })
    await expect(writeClipboard("0xabc")).resolves.toBe(false)
    expect(area.remove).toHaveBeenCalledOnce()
  })
})
