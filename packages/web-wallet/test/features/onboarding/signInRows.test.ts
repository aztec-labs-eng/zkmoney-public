// The accounts the sign-in lists: this browser's rows, earlier rollups', and the keys a tap chooses.
import { afterEach, describe, expect, it } from "vitest"
import { closeSession } from "../../../src/session/session"
import { seedDeviceKeys } from "../../support/page"
import {
  ACCOUNT,
  CREDENTIAL,
  flush,
  FOUND,
  KEYS,
  L2,
  named,
  openSignIn,
  OTHER,
  remember,
  resolved,
  typeTag,
} from "../../support/signIn"

let ended: AbortController[] = []
const open = async (...args: Parameters<typeof openSignIn>) => {
  const opened = await openSignIn(...args)
  ended.push(opened.ended)
  return opened
}
const tags = (flow: Awaited<ReturnType<typeof openSignIn>>["flow"]) =>
  flow.remembered().candidates.map((c) => c.usertag)

const SPARE = "cred-spare"
const SPARE_KEY = "cd".repeat(64)
/** @alice's sign-up key and the backup oxide's prefix names. */
const TWO_KEYS = [
  ...KEYS,
  {
    pubkeyHex: SPARE_KEY,
    metadata: `0x01${"09".repeat(100)}`,
    parsed: {
      kind: "envelope-prefixed" as const,
      credentialIdHash: `0x${"09".repeat(32)}`,
      envelope: new Uint8Array(62),
      credentialId: SPARE,
    },
  },
]
/** @alice's root record with both keys in its set and, when `spare`, the backup's record too. */
function rememberWallet(spare: boolean, root: object = {}, backup: Record<string, unknown> = {}) {
  const set = [KEYS[0]!.pubkeyHex, SPARE_KEY]
  const entries: Record<string, object> = {
    [CREDENTIAL]: {
      credentialId: CREDENTIAL,
      rpId: "localhost",
      l2Address: L2,
      pubkey: KEYS[0]!.pubkeyHex,
      isMskRoot: true,
      passkeySet: set,
      createdAt: 1,
      usertag: "alice",
      ...root,
    },
  }
  if (spare)
    entries[(backup.credentialId as string | undefined) ?? SPARE] = {
      credentialId: SPARE,
      rpId: "localhost",
      l2Address: L2,
      pubkey: SPARE_KEY,
      isMskRoot: false,
      backup: { account: ACCOUNT, envelope: `0x${"00".repeat(62)}` },
      passkeySet: set,
      createdAt: 2,
      ...backup,
    }
  return seedDeviceKeys({ passkeyMap: JSON.stringify({ version: 1, entries }) })
}
const ids = (options?: { credentialId: string; lastUsed?: true }[]) =>
  options?.map((o) => [o.credentialId, !!o.lastUsed])

afterEach(() => {
  for (const end of ended) end.abort()
  ended = []
  closeSession()
})

describe("the remembered accounts", () => {
  it("are listed newest first; ?avoid hides one", async () => {
    await remember(
      { credentialId: "cred-a", usertag: "alice", createdAt: 1, l2Address: `0x${"a1".repeat(32)}` },
      { credentialId: "cred-b", usertag: "bob", createdAt: 2, l2Address: `0x${"b2".repeat(32)}` },
      { credentialId: "cred-c", usertag: "carol", createdAt: 3, l2Address: `0x${"c3".repeat(32)}` },
    )
    const { flow } = await open("choose=1&avoid=cred-b")
    expect(tags(flow)).toEqual(["carol", "alice"])
  })

  it("a row signs in on one tap, pinned to its record, with no read", async () => {
    await remember({ credentialId: CREDENTIAL, usertag: "alice" })
    const { flow, io, lastEntry, entered } = await open()
    io.enterWithPasskey.mockResolvedValueOnce(named())
    flow.chooseAccount(flow.remembered().candidates[0]!)
    await flush()
    expect(io.lookup).not.toHaveBeenCalled()
    expect(lastEntry()).toMatchObject({
      tag: "alice",
      hints: { credentialId: CREDENTIAL },
      restoreCache: false,
    })
    expect(entered()).toBe(true)
  })

  it("a row's miss on both slots is the plain mismatch: no read proved the key sole", async () => {
    await remember({ credentialId: CREDENTIAL, usertag: "alice" })
    const { flow, io, failures } = await open()
    io.enterWithPasskey.mockResolvedValueOnce({
      entered: false,
      reason: "unknown",
      credentialId: CREDENTIAL,
      addresses: [OTHER, `0x${"ce".repeat(32)}`],
      observed: { credentialId: CREDENTIAL, attachment: "platform" },
    })
    flow.chooseAccount(flow.remembered().candidates[0]!)
    await flush()
    expect(flow.state.get().refusal?.name).toBe("PasskeyKeyMismatchError")
    expect(failures().at(-1)).toEqual(["enter:by-tag", "passkey_key_mismatch"])
  })

  it("Back forgets the row's tag: Show passkeys then runs the open chooser unnamed", async () => {
    await remember({ credentialId: CREDENTIAL, usertag: "alice" })
    const { flow, io, lastEntry } = await open()
    io.enterWithPasskey.mockRejectedValueOnce(new DOMException("closed", "NotAllowedError"))
    flow.chooseAccount(flow.remembered().candidates[0]!)
    await flush()
    expect(lastEntry().tag).toBe("alice")
    flow.back()
    io.enterWithPasskey.mockResolvedValueOnce(named("bob"))
    flow.showPasskeys()
    await flush()
    expect(lastEntry().tag).toBeUndefined()
    expect(lastEntry().chooser).toBe(true)
  })

  it("a read that lands after a row tap changes nothing, and the pinned entry settles", async () => {
    await remember({ credentialId: CREDENTIAL, usertag: "alice" })
    const { flow, io, lastEntry, entered } = await open()
    let release!: (value: unknown) => void
    io.lookup.mockReturnValueOnce(new Promise((r) => (release = r)))
    await typeTag(flow, "zed")
    let finish!: (value: unknown) => void
    io.enterWithPasskey.mockReturnValueOnce(new Promise((r) => (finish = r)))
    flow.chooseAccount(flow.remembered().candidates[0]!)
    release(resolved("zed"))
    await flush()
    expect(flow.state.get().found).toBeUndefined()
    expect((lastEntry().signal as AbortSignal).aborted).toBe(false)
    finish(named())
    await flush()
    expect(entered()).toBe(true)
  })

  it("earlier rollups' accounts follow this rollup's, which win a duplicate, and pin as they do", async () => {
    await remember({ credentialId: CREDENTIAL, usertag: "alice" })
    const { flow, io, lastEntry } = await open("", { start: false })
    const retired = (credentialId: string, usertag: string) => ({
      credentialId,
      usertag,
      l2Address: L2,
      pubkeyHex: "cd".repeat(64),
      backup: false,
    })
    io.retired.mockResolvedValue([retired(CREDENTIAL, "alice-before"), retired("cred-bob", "bob")])
    flow.start(new AbortController().signal)
    await flush()
    expect(tags(flow)).toEqual(["alice", "bob"])
    flow.chooseAccount(flow.remembered().candidates[1]!)
    await flush()
    expect(io.lookup).not.toHaveBeenCalled()
    expect(lastEntry()).toMatchObject({ tag: "bob", hints: { credentialId: "cred-bob" } })
  })
})

describe("the key choice", () => {
  it("a tag whose account lists a backup asks which key first; the backup's names it alone", async () => {
    const { flow, io, lastEntry } = await open()
    io.lookup.mockResolvedValueOnce(resolved("alice", TWO_KEYS, true))
    await typeTag(flow, "alice")
    expect(ids(flow.state.get().found?.keys)).toEqual([
      [CREDENTIAL, false],
      [SPARE, false],
    ])
    flow.login()
    expect(io.enterWithPasskey).toHaveBeenCalledTimes(1)
    io.enterWithPasskey.mockResolvedValueOnce(named())
    flow.chooseTagKey(SPARE)
    await flush()
    expect(lastEntry().hints).toEqual({ ...FOUND, keys: TWO_KEYS, chosen: SPARE })
    expect(io.fire).toHaveBeenCalledWith("passkey_by_tag_lookup_resolved", { more_keys: true })
  })

  it("a one-key tag offers no choice: Login pins the account's keys", async () => {
    const { flow, io, lastEntry } = await open()
    io.lookup.mockResolvedValueOnce(resolved())
    await typeTag(flow, "alice")
    expect(flow.state.get().found?.keys).toBeUndefined()
    flow.login()
    await flush()
    expect(lastEntry().hints).toEqual(FOUND)
  })

  it("a row whose backup this browser recorded opens its keys with no read; each pins its record", async () => {
    await rememberWallet(true)
    const { flow, io, lastEntry } = await open()
    const [row] = flow.remembered().candidates
    expect(flow.remembered().keyed.has(row!.credentialId)).toBe(true)
    flow.chooseAccount(row!)
    expect(ids(flow.state.get().row?.options)).toEqual([
      [CREDENTIAL, false],
      [SPARE, false],
    ])
    expect(io.lookup).not.toHaveBeenCalled()
    // A second tap closes the list.
    flow.chooseAccount(row!)
    expect(flow.state.get().row).toBeUndefined()
    flow.chooseAccount(row!)
    flow.chooseRowKey(SPARE)
    await flush()
    expect(lastEntry()).toMatchObject({
      tag: "alice",
      hints: { credentialId: SPARE, chosen: true },
      restoreCache: false,
    })
  })

  it("a row whose backup has no record here reads the tag, then names the chain's key", async () => {
    await rememberWallet(false)
    const { flow, io, lastEntry } = await open()
    flow.chooseAccount(flow.remembered().candidates[0]!)
    await flush()
    expect(io.lookup).toHaveBeenCalledWith("alice", expect.anything())
    expect(flow.state.get().row?.failed).toBe(true)
    io.lookup.mockResolvedValueOnce(resolved("alice", TWO_KEYS, true))
    flow.rowAgain()
    await flush()
    flow.chooseRowKey(SPARE)
    await flush()
    expect(lastEntry().hints).toEqual({ ...FOUND, keys: TWO_KEYS, chosen: SPARE })
  })

  it("a wallet remembered under both keys is one row, by the record naming the most keys", async () => {
    await rememberWallet(true, { passkeySet: undefined }, { usertag: "alice", createdAt: 5 })
    const { flow } = await open()
    const { candidates, keyed } = flow.remembered()
    expect(candidates.map((c) => c.credentialId)).toEqual([SPARE])
    expect(keyed.has(SPARE)).toBe(true)
  })

  it("?avoid hides the failed key's record, and the wallet's other record still lists it", async () => {
    await rememberWallet(true, {}, { usertag: "alice" })
    const { flow } = await open("choose=1&avoid=cred-alice")
    expect(flow.remembered().candidates.map((c) => c.credentialId)).toEqual([SPARE])
  })

  it("points at the key this browser last opened the wallet with, for a row and a typed tag", async () => {
    await rememberWallet(true, { usedAt: 100 }, { usedAt: 200 })
    const { flow, io } = await open()
    flow.chooseAccount(flow.remembered().candidates[0]!)
    const lastUsed = [
      [CREDENTIAL, false],
      [SPARE, true],
    ]
    expect(ids(flow.state.get().row?.options)).toEqual(lastUsed)
    io.lookup.mockResolvedValueOnce(resolved("alice", TWO_KEYS, true))
    await typeTag(flow, "alice")
    flow.differentPasskey()
    await flush()
    expect(ids(flow.state.get().found?.keys)).toEqual(lastUsed)
  })

  it("shows one account's keys at a time: a row clears the tag, typing a tag leaves the row", async () => {
    await rememberWallet(true)
    const { flow } = await open()
    flow.tagChanged("bob")
    flow.chooseAccount(flow.remembered().candidates[0]!)
    expect(flow.state.get().typed).toBe("")
    expect(flow.state.get().row).toBeDefined()
    flow.tagChanged("carol")
    expect(flow.state.get()).toMatchObject({ row: undefined, typed: "carol" })
  })

  it("?pick opens the named row's keys with no arrival probe", async () => {
    await rememberWallet(true)
    const { flow, io } = await open("pick=cred-alice")
    expect(io.enterWithPasskey).not.toHaveBeenCalled()
    expect(ids(flow.state.get().row?.options)).toHaveLength(2)
  })

  it("?pick opens the wallet's shown row when the list keeps another record", async () => {
    // A third key: the sign-up key's record names two, a later backup's names all three.
    const third = "ef".repeat(64)
    await rememberWallet(
      true,
      {},
      {
        credentialId: "cred-third",
        pubkey: third,
        usertag: "alice",
        createdAt: 3,
        passkeySet: [KEYS[0]!.pubkeyHex, SPARE_KEY, third],
      },
    )
    const { flow, io } = await open("pick=cred-alice", { start: false })
    io.lookup.mockReturnValueOnce(new Promise(() => {}))
    flow.start(new AbortController().signal)
    await flush()
    expect(flow.remembered().candidates).toHaveLength(1)
    // The kept row is open; its unrecorded key is being read from the chain.
    expect(flow.state.get().row?.reading).toBe(true)
    expect(io.lookup).toHaveBeenCalledWith("alice", expect.anything())
  })
})
