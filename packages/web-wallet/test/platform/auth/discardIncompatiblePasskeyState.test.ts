import { beforeEach, describe, expect, it } from "vitest"
import { walletStorage } from "../../../src/platform/storage/walletStorage"
import { discardIncompatiblePasskeyState } from "../../../src/platform/auth/discardIncompatiblePasskeyState"
import {
  WebPasskeyIdentityMap,
  hasOpeningBreadcrumb,
} from "../../../src/platform/auth/WebPasskeyIdentityMap"
import { readIdentity, stageIdentity, type Write } from "@obsidion/front-core"
import { activeNamespace, namespaceOf } from "../../../src/session/session"
import { cachedMsk } from "../../../src/platform/storage/activeStorage"
import { writeDeviceKeys } from "../../../src/platform/storage/deviceKeys"
import { committed, testCore, testPage } from "../../support/page"
import { setIdentity } from "../../support/identity"

const deviceDb = testPage().database

const entry = {
  credentialId: "credential",
  pubkey: "ab".repeat(64),
  l2Address: `0x${"cd".repeat(32)}`,
  isMskRoot: true,
}
const cache = {
  v: 1 as const,
  storageId: "storage",
  credentialId: entry.credentialId,
  msk: `0x${"ef".repeat(32)}`,
}
const map = (rpId: string) => new WebPasskeyIdentityMap(deviceDb, rpId)
const clearIdentity = (w: Write) =>
  stageIdentity(w, activeNamespace(testCore().device).prefix, null)

beforeEach(() => localStorage.clear())

describe("discarding state before account restoration", () => {
  it("clears old-RP records and active pointers", async () => {
    await map("wallet.zk.money").upsert(entry)
    await writeDeviceKeys(deviceDb, {
      storageId: cache.storageId,
      credentialId: entry.credentialId,
      msk: JSON.stringify(cache),
    })
    await setIdentity({ address: entry.l2Address })
    await discardIncompatiblePasskeyState(
      deviceDb,
      testCore().device,
      "auth.zk.money",
      clearIdentity,
    )
    expect(committed().storageId).toBeNull()
    expect(committed().credentialId).toBeNull()
    expect(cachedMsk(committed())).toBeNull()
    expect(await readIdentity(deviceDb.scoped(namespaceOf(cache.storageId).prefix))).toBeNull()
    expect(walletStorage.getItem("webwallet.identity")).toBeNull()
    expect(await map("wallet.zk.money").get(entry.credentialId)).toBeUndefined()
    expect(hasOpeningBreadcrumb(committed().passkeyMap, "auth.zk.money")).toBe(false)
    await map("auth.zk.money").upsert(entry)
    expect(hasOpeningBreadcrumb(committed().passkeyMap, "auth.zk.money")).toBe(true)
  })

  it("preserves current records and keys", async () => {
    await map("localhost").upsert(entry)
    await writeDeviceKeys(deviceDb, {
      storageId: cache.storageId,
      credentialId: entry.credentialId,
      msk: JSON.stringify(cache),
    })
    await walletStorage.flush()
    await discardIncompatiblePasskeyState(deviceDb, testCore().device, "localhost", clearIdentity)
    expect(committed().storageId).toBe(cache.storageId)
    expect(cachedMsk(committed())).toEqual(cache)
  })

  it.each([null, [], { bad: null }])(
    "allows onboarding with malformed identity entries %s",
    async (entries) => {
      walletStorage.setItem(
        "obsidion.obsidion_web_passkey_identity_map",
        JSON.stringify({ version: 1, entries }),
      )
      await expect(
        discardIncompatiblePasskeyState(
          deviceDb,
          testCore().device,
          "auth.zk.money",
          clearIdentity,
        ),
      ).resolves.toBeUndefined()
      expect(committed().storageId).toBeNull()
    },
  )

  it("drops a different session's key while preserving the valid active session", async () => {
    await map("auth.zk.money").upsert(entry)
    await writeDeviceKeys(deviceDb, {
      storageId: cache.storageId,
      credentialId: entry.credentialId,
      msk: JSON.stringify({ ...cache, credentialId: "stale" }),
    })
    await walletStorage.flush()
    await discardIncompatiblePasskeyState(
      deviceDb,
      testCore().device,
      "auth.zk.money",
      clearIdentity,
    )
    expect(committed().credentialId).toBe(entry.credentialId)
    expect(cachedMsk(committed())).toBeNull()
  })
})
