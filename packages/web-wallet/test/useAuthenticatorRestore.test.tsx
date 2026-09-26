/**
 * The wallet hands the auth service its address derivation and its stored account in the same
 * render front-core's account effect depends on, so a cached key proves out before that effect asks
 * for it: the read that follows returns the key with no ceremony.
 */
import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { Fr } from "@aztec/aztec.js/fields"
import { AUTH_TYPE } from "@obsidion/sdk"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const ADDR = `0x${"aa".repeat(32)}`
const PUBKEY = "ab".repeat(64)
const CRED = "cred-1"

const h = vi.hoisted(() => ({
  wallet: undefined as unknown,
  getAccount: vi.fn(),
}))

vi.mock("@obsidion/front-core", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@obsidion/front-core")>()),
  useAztecContext: () => ({ obsidionWallet: h.wallet }),
  AccountStorage: { get: () => ({ getAccount: h.getAccount }) },
  compAddrToAztecAddrStr: async (complete: string) => complete.replace(/:complete$/, ""),
}))
vi.mock("../src/config/env", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/config/env")>()),
  getConfig: () => ({ rpId: "localhost", rpName: "zk.money" }),
}))

const { getAuthService, useAuthenticator } = await import("../src/platform/auth/useAuthenticator")
const { WebPasskeyIdentityMap } = await import("../src/platform/auth/WebPasskeyIdentityMap")
const { webStorage } = await import("../src/platform/storage/WebStorageAdapter")
const {
  readCachedMsk,
  setActiveCredentialId,
  setActiveStorageId,
  storageIdFromSecret,
  writeCachedMsk,
} = await import("../src/platform/storage/activeStorage")

function Probe() {
  useAuthenticator()
  return null
}

let container: HTMLDivElement
let root: Root
const msk = Fr.random()

/** A session as a commit leaves it on disk. */
async function seedSession() {
  const storageId = await storageIdFromSecret(new Uint8Array(msk.toBuffer()))
  setActiveStorageId(storageId)
  setActiveCredentialId(CRED)
  writeCachedMsk({ v: 1, storageId, credentialId: CRED, msk: msk.toString() })
  await new WebPasskeyIdentityMap(webStorage, "localhost").upsert({
    credentialId: CRED,
    l2Address: ADDR,
    pubkey: PUBKEY,
    prfSlot: "first",
    isMskRoot: true,
  })
  h.getAccount.mockResolvedValue({
    completeAddress: `${ADDR}:complete`,
    signKeyConfig: {
      type: AUTH_TYPE.WEB_AUTHN,
      webauthnData: { credentialId: CRED, pubkey: PUBKEY },
    },
  })
}

beforeEach(async () => {
  localStorage.clear()
  getAuthService().clear()
  h.wallet = undefined
  await seedSession()
  container = document.createElement("div")
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

const render = () => act(async () => root.render(<Probe />))

// The service is a process singleton and keeps what the wallet injected; the no-wallet case runs first.
describe("useAuthenticator and the cached key", () => {
  it("before the wallet exists nothing is injected and the read stays locked, cache kept", async () => {
    await render()
    expect(await getAuthService().getSecretKey()).toBeUndefined()
    expect(readCachedMsk()).not.toBeNull()
  })

  it("with the wallet mounted, the first key read restores from the cache with no ceremony", async () => {
    const deriveAccountAddress = vi.fn(async (candidate: Fr, pubkeyHex: string) => ({
      toString: () =>
        candidate.toString() === msk.toString() && pubkeyHex === PUBKEY ? ADDR : "0xother",
    }))
    h.wallet = { deriveAccountAddress }
    await render()
    expect((await getAuthService().getSecretKey())?.toString()).toBe(msk.toString())
    expect(getAuthService().isUnlocked()).toBe(true)
    expect(readCachedMsk()).not.toBeNull()
    // The cached key is proved under the record's signing key.
    expect(deriveAccountAddress).toHaveBeenCalledWith(msk, PUBKEY)
  })

  it("a wallet deriving another address drops the cache and stays locked", async () => {
    h.wallet = { deriveAccountAddress: async () => ({ toString: () => "0xother" }) }
    await render()
    expect(await getAuthService().getSecretKey()).toBeUndefined()
    expect(readCachedMsk()).toBeNull()
  })

  it("an address that exists only under another signing key drops the cache", async () => {
    h.wallet = {
      deriveAccountAddress: async (_candidate: Fr, pubkeyHex: string) => ({
        toString: () => (pubkeyHex === "ff".repeat(64) ? ADDR : "0xother"),
      }),
    }
    await render()
    expect(await getAuthService().getSecretKey()).toBeUndefined()
    expect(readCachedMsk()).toBeNull()
  })
})
