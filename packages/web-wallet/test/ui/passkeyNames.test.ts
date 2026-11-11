// @vitest-environment node
import { memoryBackend, openDatabase } from "@obsidion/front-core"
import { describe, expect, it } from "vitest"
import { deviceState } from "../../src/platform/storage/deviceKeys"
import { savePasskeyName } from "../../src/ui/passkeyNames"

describe("savePasskeyName", () => {
  it("keeps both of two renames saved one after the other without waiting", async () => {
    const backend = memoryBackend()
    await backend.apply([["webwallet.passkey-names", JSON.stringify({ a: "Old" })]])
    const db = openDatabase(backend)
    const device = deviceState(db, () => true)
    await device.load()
    savePasskeyName(db, "a", " Work  laptop ")
    savePasskeyName(db, "b", "Phone")
    await db.write(async () => {})
    expect(device.get().passkeyNames).toEqual({ a: "Work laptop", b: "Phone" })
    expect(JSON.parse(backend.entries.get("webwallet.passkey-names") ?? "")).toEqual({
      a: "Work laptop",
      b: "Phone",
    })
  })
})
