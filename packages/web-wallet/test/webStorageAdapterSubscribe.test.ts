import { describe, expect, it } from "vitest"
import { WebStorageAdapter } from "../src/platform/storage/WebStorageAdapter"

const fire = (key: string | null) =>
  window.dispatchEvent(new StorageEvent("storage", { key: key as string | undefined }))

describe("WebStorageAdapter.subscribe", () => {
  it("fires on a cross-tab write to the subscribed (prefixed) key only", () => {
    const adapter = new WebStorageAdapter()
    let calls = 0
    const unsubscribe = adapter.subscribe("obsidion_contacts", () => calls++)

    fire("obsidion.obsidion_contacts")
    expect(calls).toBe(1)

    fire("obsidion.some_other_key")
    fire("obsidion_contacts") // unprefixed — not this adapter's key
    expect(calls).toBe(1)

    // A null key is a full localStorage clear — every key is affected.
    fire(null)
    expect(calls).toBe(2)

    unsubscribe()
    fire("obsidion.obsidion_contacts")
    expect(calls).toBe(2)
  })
})
