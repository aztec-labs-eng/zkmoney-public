// @vitest-environment node
import { loadRecords, memoryBackend, openMasterKey } from "@obsidion/front-core"
import { bytesToBase64Url } from "@obsidion/passkey-web"
import { describe, expect, it } from "vitest"
import {
  LeftoverPasskeyError,
  startBackupAdd,
} from "../../../src/features/backupPasskey/backupPasskeyAdd"
import { MASTER_KEY, OWNER, makeBackupAddDeps } from "../../support/backupAdd"

const hex = (bytes: Uint8Array) => Buffer.from(bytes).toString("hex")

describe("starting a backup add", () => {
  it("creates the backup, seals the master key under its PRF and saves the attempt", async () => {
    const { deps, store, ceremony, seen, outcomes } = makeBackupAddDeps()
    const record = await startBackupAdd(deps)
    expect(record.phase).toBe("created")
    expect(record.owner).toBe(OWNER)
    expect(ceremony.creates).toHaveLength(1)
    expect(ceremony.asserts).toHaveLength(0)
    expect(ceremony.creates[0].userName).toBe("brave-otter-42")
    const cred = ceremony.creds.get(record.backup.credentialId)!
    expect(record.backup.pubkeyHex).toHaveLength(128)
    expect(cred).toBeDefined()
    const opened = await openMasterKey({
      envelope: Buffer.from(record.backup.envelopeHex!, "hex"),
      prf: { first: seen.prf! },
      account: OWNER,
      credentialId: record.backup.credentialId,
    })
    expect(hex(opened)).toBe(hex(MASTER_KEY))
    expect(record.backup.userHandle).toBe(bytesToBase64Url(cred.handle))
    expect((await store.get(OWNER))?.attemptId).toBe("attempt-1")
    expect(outcomes).toEqual(["succeeded"])
  })

  it("refuses a second attempt while one is saved, and leaves the saved one as it is", async () => {
    const { deps, store } = makeBackupAddDeps()
    const first = await startBackupAdd(deps)
    deps.attemptId = () => "attempt-2"
    await expect(startBackupAdd(deps)).rejects.toThrow("already pending")
    const kept = await store.get(OWNER)
    expect(kept?.attemptId).toBe("attempt-1")
    expect(kept?.backup.credentialId).toBe(first.backup.credentialId)
  })

  it("an add ended while the store was being read saves nothing", async () => {
    const abort = new AbortController()
    const { deps, store, backend } = makeBackupAddDeps()
    await loadRecords(store.view)
    const get = backend.get
    backend.get = async (key) => {
      abort.abort()
      return get(key)
    }
    await expect(startBackupAdd(deps, abort.signal)).rejects.toThrow()
    backend.get = get
    expect(await store.get(OWNER)).toBeNull()
  })

  it("an add ended while its record was being written drops that record", async () => {
    const abort = new AbortController()
    const { deps, store, backend, outcomes } = makeBackupAddDeps()
    await store.ready
    const apply = backend.apply
    backend.apply = async (ops) => {
      abort.abort()
      return apply(ops)
    }
    await expect(startBackupAdd(deps, abort.signal)).rejects.toBeInstanceOf(LeftoverPasskeyError)
    backend.apply = apply
    expect(await store.get(OWNER)).toBeNull()
    expect(outcomes).toEqual(["failed"])
  })

  it("zeroes the PRF output and its master key copy once the key is sealed", async () => {
    let handed: Uint8Array | undefined
    const { deps } = makeBackupAddDeps({
      driver: async (ceremony, options) => {
        const created = await ceremony.create({
          rpId: options.rpId,
          rpName: options.rpName,
          userName: options.userName,
          prfFirstSalt: new Uint8Array(32).fill(1),
        })
        handed = created.prfFirst!
        return {
          created,
          slot: "first",
          prfOutput: created.prfFirst!,
          securityKey: false,
          facts: { provider: "unknown" },
        }
      },
    })
    const copies: Uint8Array[] = []
    const read = deps.masterKey
    deps.masterKey = () => {
      const copy = read()
      copies.push(copy)
      return copy
    }
    await startBackupAdd(deps)
    expect(handed!.every((b) => b === 0)).toBe(true)
    expect(copies).toHaveLength(1)
    expect(copies[0].every((b) => b === 0)).toBe(true)
    expect(MASTER_KEY.every((b) => b === 7)).toBe(true)
  })

  it("zeroes the PRF output when sealing fails", async () => {
    let handed: Uint8Array | undefined
    const { deps, store } = makeBackupAddDeps({
      driver: async (ceremony, options) => {
        const created = await ceremony.create({
          rpId: options.rpId,
          rpName: options.rpName,
          userName: options.userName,
          prfFirstSalt: new Uint8Array(32).fill(1),
        })
        handed = created.prfFirst!
        return {
          created,
          slot: "first",
          prfOutput: created.prfFirst!,
          securityKey: false,
          facts: { provider: "unknown" },
        }
      },
      seal: async () => {
        throw new Error("seal broke")
      },
    })
    await expect(startBackupAdd(deps)).rejects.toThrow("seal broke")
    await expect(startBackupAdd(deps)).rejects.toMatchObject({ name: "LeftoverPasskeyError" })
    expect(handed!.every((b) => b === 0)).toBe(true)
    expect(await store.get(OWNER)).toBeNull()
  })

  it("zeroes the PRF output when the master key cannot be read", async () => {
    let handed: Uint8Array | undefined
    const { deps, store } = makeBackupAddDeps({
      driver: async (ceremony, options) => {
        const created = await ceremony.create({
          rpId: options.rpId,
          rpName: options.rpName,
          userName: options.userName,
          prfFirstSalt: new Uint8Array(32).fill(1),
        })
        handed = created.prfFirst!
        return {
          created,
          slot: "first",
          prfOutput: created.prfFirst!,
          securityKey: false,
          facts: { provider: "unknown" },
        }
      },
    })
    deps.masterKey = () => {
      throw new Error("locked")
    }
    await expect(startBackupAdd(deps)).rejects.toThrow("locked")
    expect(handed!.every((b) => b === 0)).toBe(true)
    expect(await store.get(OWNER)).toBeNull()
  })

  it("a write the database refuses ends the attempt", async () => {
    const { deps, store, backend, outcomes } = makeBackupAddDeps()
    await store.ready
    backend.failing.commits = true
    await expect(startBackupAdd(deps)).rejects.toBeInstanceOf(LeftoverPasskeyError)
    backend.failing.commits = false
    expect(await store.get(OWNER)).toBeNull()
    expect(outcomes).toEqual(["failed"])
  })

  it("refuses to start over a saved record that does not read, never reading it as none", async () => {
    const backend = memoryBackend()
    const key = `acct/backupRotations/${OWNER.toLowerCase()}`
    backend.entries.set(key, JSON.stringify({ owner: OWNER, phase: "typo" }))
    const { deps, store, outcomes } = makeBackupAddDeps({ backend })
    await expect(startBackupAdd(deps)).rejects.toThrow()
    expect(store.view.get().failed).toBe(true)
    expect(outcomes).toEqual(["failed"])
    expect(backend.entries.get(key)).toBe(JSON.stringify({ owner: OWNER, phase: "typo" }))
  })
})
