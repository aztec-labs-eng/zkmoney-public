import { Fr } from "@aztec-labs/aztec.js/fields"
import { describe, expect, it } from "vitest"
import {
  BACKUP_ROTATION_ATTENTIONS,
  BACKUP_ROTATION_PHASES,
  RotationStrippedError,
  WalletError,
  createBackupRotations,
  loadRecords,
  memoryBackend,
  openDatabase,
  fundingLocalId,
  moveDeclined,
  moveProgress,
  movesBalance,
  persistedRotation,
  refundProgress,
  rerootAhead,
  storeRotation,
  stripSettled,
  type BackupFunding,
  type BackupRotationPhase,
  type BackupRotationRecord,
  type BackupRotationStored,
  type BackupRotations,
} from "../../src/index.js"

const OWNER = "0xAbCdEf0000000000000000000000000000001234"
const addr = (n: number) => `0x${n.toString(16).padStart(40, "0")}` as `0x${string}`
const word = (n: number) => `0x${n.toString(16).padStart(64, "0")}` as `0x${string}`

const stored = (over: Partial<BackupRotationStored> = {}): BackupRotationStored => ({
  owner: addr(1),
  intent: {
    rollupVersion: "6",
    recipientCommitment: word(5),
    owner: addr(1),
    nonce: "7",
    accountGasLimits: word(8),
    record: {
      l2Address: word(0x2b),
      rollupVersion: "6",
      publicKey: { x: "11", y: "12" },
      resolverOperator: addr(13),
    },
    namePortalRecipient: word(0x2b),
    key: { qx: word(21), qy: word(22) },
    metadata: "0x0134",
  },
  sharedSecretSalt: word(9),
  nonce: "7",
  builtOver: {
    l2Address: word(10),
    rollupVersion: "6",
    publicKey: { x: "11", y: "12" },
    resolverOperator: addr(13),
  },
  expectedKeys: [{ key: { qx: word(14), qy: word(15) }, metadata: "0x" }],
  implementation: addr(16),
  deployArgs: {
    implementation: addr(16),
    intentHash: word(17),
    recoveryCommitment: word(18),
    rollupVersion: "6",
    resweepable: false,
    forwardingTable: addr(19),
  },
  sipa: addr(20),
  add: { pubkey: { qx: word(21), qy: word(22) }, credentialId: "0x2324", envelope: "0x25" },
  signature: "0x26",
  ...over,
})

const funding = (over: Partial<BackupFunding> = {}): BackupFunding => ({
  attemptId: "attempt-1",
  localId: fundingLocalId("attempt-1"),
  sentAt: 5,
  session: "life-1",
  txHash: word(30),
  expiresAtMs: 99,
  outcome: "pending",
  ...over,
})

const record = (over: Partial<BackupRotationRecord> = {}): BackupRotationRecord => ({
  owner: OWNER,
  attemptId: "attempt-1",
  phase: "created",
  backup: {
    credentialId: "backup-credential",
    pubkeyHex: "ab".repeat(64),
    envelopeHex: "01".repeat(62),
    userHandle: "YnJhdmUtb3R0ZXI",
    prfSlot: "first",
    securityKey: false,
  },
  plan: {
    address: "0x22",
    fundingAmount: "2000",
    deposited: "1800",
    credited: "1400",
    approvals: 1,
    moves: 2,
  },
  rotation: stored(),
  fundings: [],
  createdAt: 1,
  updatedAt: 1,
  ...over,
})

const NS = "obsidion.acct."
const LEGACY = `${NS}obsidion_backup_rotation`
const blob = (key: string, value: unknown) => JSON.stringify({ [key]: value })
const intentWithout = (field: keyof BackupRotationStored["intent"]) => {
  const intent: Partial<BackupRotationStored["intent"]> = { ...stored().intent }
  delete intent[field]
  return intent as BackupRotationStored["intent"]
}

/** The account's rotations over `entries`: a reopen over the same entries is a reload. */
function rotationsOver(entries = new Map<string, string>()) {
  const backend = memoryBackend(entries)
  return {
    entries,
    backend,
    store: createBackupRotations({ db: openDatabase(backend).scoped(NS) }),
  }
}

/** The record keys saved in the new layout. */
const savedKeys = (entries: Map<string, string>) =>
  [...entries.keys()].filter((key) => key.startsWith(`${NS}acct/backupRotations/`))

/** A value that fails the record check, one per field the check reads. */
function damaged(): unknown[] {
  const saved = record()
  const signed = record({ phase: "signed" })
  return [
    null,
    { owner: 5 },
    { ...saved, phase: "typo" },
    { ...saved, phase: "attention" },
    { ...saved, fundings: undefined },
    { ...saved, fundings: [{ ...funding(), outcome: "lost" }] },
    { ...saved, fundings: [{ ...funding(), session: undefined }] },
    { ...saved, fundings: [{ ...funding(), txHash: "0x30" }] },
    { ...saved, sweep: { index: "3", blockHash: word(42), credited: "1400", recheck: "pending" } },
    { ...saved, sweep: { index: "3", blockNumber: "90", blockHash: word(42), credited: "1400" } },
    { ...saved, dismissed: false },
    { ...signed, plan: undefined },
    { ...signed, rotation: undefined },
    { ...signed, rotation: stored({ signature: undefined }) },
    { ...signed, rotation: stored({ sharedSecretSalt: undefined }) },
    { ...signed, rotation: stored({ sharedSecretSalt: `0x${"ff".repeat(32)}` }) },
    { ...signed, rotation: stored({ add: { ...stored().add, envelope: undefined } }) },
    { ...signed, rotation: stored({ sipa: "0x20" }) },
    { ...signed, rotation: stored({ nonce: "seven" }) },
    { ...signed, rotation: stored({ intent: { ...stored().intent, metadata: "0xabc" } }) },
    { ...signed, rotation: stored({ intent: intentWithout("record") }) },
    { ...signed, rotation: stored({ intent: intentWithout("key") }) },
    { ...signed, rotation: stored({ intent: intentWithout("metadata") }) },
    { ...signed, rotation: stored({ intent: intentWithout("namePortalRecipient") }) },
    {
      ...signed,
      rotation: stored({
        intent: { ...stored().intent, key: { ...stored().intent.key, qx: "0x21" } },
      }),
    },
    {
      ...signed,
      rotation: stored({
        intent: {
          ...stored().intent,
          record: { ...stored().intent.record, publicKey: { x: "eleven", y: "12" } },
        },
      }),
    },
    // An intent persisted in the earlier call-data shape is refused.
    {
      ...signed,
      rotation: {
        ...stored(),
        intent: {
          rollupVersion: "6",
          precondition: { target: addr(2), data: "0x1234", resultHash: word(3) },
          postcondition: { target: addr(2), data: "0x1234", resultHash: word(4) },
          recipientCommitment: word(5),
          owner: addr(1),
          nonce: "7",
          callData: "0xabcd",
          accountGasLimits: word(8),
        },
      },
    },
    { ...saved, plan: { ...saved.plan, fundingAmount: "oops" } },
    { ...saved, plan: { ...saved.plan, deposited: "oops" } },
    { ...saved, plan: { ...saved.plan, takesMs: "40 min" } },
    { ...saved, plan: { ...saved.plan, proverTip: "oops" } },
    { ...saved, publish: { count: 1, history: [{ txHash: word(1) }] } },
    { ...saved, sweep: { index: 3, blockHash: word(1), credited: "1" } },
    { ...saved, move: { runs: [{ plannedAt: 1, m: 1, depositBound: false }] } },
    {
      ...saved,
      move: { runs: [{ plannedAt: 1, m: 1, depositBound: false, declined: false, chunks: [] }] },
    },
    {
      ...saved,
      move: {
        runs: [
          {
            plannedAt: 1,
            m: 1,
            depositBound: false,
            chunks: [{ token: "t", amount: "1", state: "sent" }],
          },
        ],
      },
    },
    // Home sums `oneKeyBalances` as bigints, so a figure that is not a decimal must fail the read.
    { ...saved, reroot: { switched: true, oneKeyBalances: [{ token: "t", amount: "1.5" }] } },
    { ...saved, refunds: { links: [{ link: "row-1", state: "sent" }] } },
    { ...saved, refunds: { links: [{ state: "planned" }] } },
    { ...saved, refunds: { declined: false, links: [] } },
    { ...saved, plan: { ...saved.plan, refunds: "2" } },
    { ...saved, backup: { ...saved.backup, prfSlot: "third" } },
    { ...saved, backup: { ...saved.backup, envelopeHex: undefined } },
    { ...signed, backup: { ...saved.backup, envelopeHex: "zz" } },
    { ...saved, backup: { ...saved.backup, envelopeHex: "01".repeat(61) } },
  ]
}

/** Every read and write of a store that failed closed rejects; its view is failed, never empty. */
async function expectClosed(store: BackupRotations) {
  await expect(loadRecords(store.view)).rejects.toBeInstanceOf(WalletError)
  expect(store.view.get().failed).toBe(true)
  await expect(store.get(OWNER)).rejects.toBeDefined()
  await expect(store.put(record())).rejects.toBeDefined()
  await expect(store.update(OWNER, () => record())).rejects.toBeDefined()
  await expect(store.removeIf(OWNER, () => true)).rejects.toBeDefined()
}

describe("createBackupRotations", () => {
  it("keeps one record per owner, whatever the owner's case", async () => {
    const { store } = rotationsOver()
    await store.put(record())
    await store.put(record({ phase: "signed", owner: OWNER.toLowerCase() }))
    expect((await store.get(OWNER.toUpperCase().replace("0X", "0x")))?.phase).toBe("signed")
    expect(await loadRecords(store.view)).toHaveLength(1)
    await store.remove(OWNER)
    expect(await store.get(OWNER)).toBeNull()
  })

  it("reads a saved record back after a reload", async () => {
    const { entries, store } = rotationsOver()
    await store.put(record({ phase: "published" }))
    expect((await rotationsOver(entries).store.get(OWNER))?.phase).toBe("published")
  })

  it("reads a plan with no deposited amount", async () => {
    const { entries, store } = rotationsOver()
    await store.put(record({ plan: { ...record().plan!, deposited: undefined } }))
    const plan = (await rotationsOver(entries).store.get(OWNER))?.plan
    expect(plan?.fundingAmount).toBe("2000")
    expect(plan?.deposited).toBeUndefined()
  })

  it("reads a plan's prover tip, and none where the funding carried no tip", async () => {
    const { entries, store } = rotationsOver()
    await store.put(record({ plan: { ...record().plan!, proverTip: "400" } }))
    expect((await rotationsOver(entries).store.get(OWNER))?.plan?.proverTip).toBe("400")
    await store.put(record())
    expect((await rotationsOver(entries).store.get(OWNER))?.plan?.proverTip).toBeUndefined()
  })

  it("round-trips every phase and every attention reason with its fields", async () => {
    const full = (phase: BackupRotationPhase): BackupRotationRecord =>
      record({
        phase,
        fromBlock: 100,
        publish: {
          txHash: word(40),
          l2Block: 12,
          count: 2,
          lastAt: 50,
          history: [{ txHash: word(40), l2Block: 12, at: 50 }],
        },
        fundings: [
          funding({ outcome: "never-sent", txHash: undefined, expiresAtMs: undefined }),
          funding({ attemptId: "attempt-2", localId: fundingLocalId("attempt-2") }),
          funding({
            attemptId: "attempt-3",
            localId: fundingLocalId("attempt-3"),
            outcome: "swept",
          }),
        ],
        installed: { blockHash: word(41) },
        sweep: {
          index: "3",
          blockNumber: 90,
          blockHash: word(42),
          credited: "1400",
          recheck: "gone",
        },
        unswept: true,
        dismissed: true,
        recovery: { txHash: word(43) },
        reroot: {
          batch: word(44),
          switched: true,
          rebound: true,
          receiveCode: false,
          oneKeyBalances: [{ token: addr(50), amount: "1400" }],
        },
        move: {
          runs: [
            {
              plannedAt: 60,
              m: 2,
              depositBound: true,
              declined: true,
              chunks: [
                {
                  token: addr(50),
                  amount: "700",
                  state: "included",
                  txHash: word(45),
                  expiresAtMs: 70,
                  inclusion: { blockNumber: 9, blockHash: "0x99" },
                  effect: "reverted",
                },
                {
                  token: addr(50),
                  amount: "700",
                  state: "claimed",
                  claim: { id: "send-1", session: "life-1" },
                },
                { token: addr(50), amount: "700", state: "planned" },
              ],
            },
          ],
        },
        refunds: {
          declined: true,
          links: [
            { link: "row-1", state: "mined", txHash: word(46), expiresAtMs: 80 },
            { link: "row-2", state: "skipped" },
            { link: "row-3", state: "planned" },
          ],
        },
      })
    for (const phase of BACKUP_ROTATION_PHASES) {
      const saved =
        phase === "attention"
          ? BACKUP_ROTATION_ATTENTIONS.map((attention) => ({
              ...full(phase),
              attention,
              suspended: "funded" as const,
            }))
          : [full(phase)]
      for (const r of saved) {
        const { entries, store } = rotationsOver()
        await store.put(r)
        expect(await rotationsOver(entries).store.get(OWNER)).toEqual(r)
      }
    }
  })

  it("reads an empty store as absent", async () => {
    expect(await rotationsOver().store.get(OWNER)).toBeNull()
  })

  it("rejects a write the database refuses, so nothing acts on an unsaved record", async () => {
    const { backend, store } = rotationsOver()
    await store.ready
    backend.failing.commits = true
    await expect(store.put(record())).rejects.toBeInstanceOf(WalletError)
    backend.failing.commits = false
    expect(await store.get(OWNER)).toBeNull()
  })

  it("keeps a record whose removal the database refused, so a retry still removes it", async () => {
    const { backend, store } = rotationsOver()
    await store.put(record())
    backend.failing.commits = true
    await expect(store.remove(OWNER)).rejects.toBeInstanceOf(WalletError)
    backend.failing.commits = false
    expect((await store.get(OWNER))?.attemptId).toBe("attempt-1")
    await store.remove(OWNER)
    expect(await store.get(OWNER)).toBeNull()
  })

  it("fails closed over a saved record that does not read, never as no rotation", async () => {
    for (const value of damaged()) {
      const { entries, store } = rotationsOver()
      await store.put(record())
      const key = `${NS}acct/backupRotations/${OWNER.toLowerCase()}`
      entries.set(key, JSON.stringify(value))
      await expectClosed(rotationsOver(entries).store)
      expect(entries.get(key)).toBe(JSON.stringify(value))
    }
  })

  it("fails closed over a record saved under another owner's key", async () => {
    const { entries, store } = rotationsOver()
    await store.put(record())
    const key = `${NS}acct/backupRotations/${OWNER.toLowerCase()}`
    entries.set(key, JSON.stringify(record({ owner: addr(0x77) })))
    const reopened = rotationsOver(entries).store
    await expectClosed(reopened)
    await expect(reopened.get(addr(0x77))).rejects.toBeDefined()
  })

  it("drops a record only while it still passes the check", async () => {
    const { store } = rotationsOver()
    await store.put(record())
    expect(await store.removeIf(OWNER, (current) => current.phase === "signed")).toBe(false)
    expect((await store.get(OWNER))?.attemptId).toBe("attempt-1")
    expect(await store.removeIf(OWNER, (current) => current.phase === "created")).toBe(true)
    expect(await store.get(OWNER)).toBeNull()
    expect(await store.removeIf(OWNER, () => true)).toBe(false)
  })

  it("changes a record over what it holds, in one step", async () => {
    const { store } = rotationsOver()
    await store.put(record())
    const next = await store.update(OWNER.toLowerCase(), (current) =>
      current ? { ...current, phase: "signed" } : null,
    )
    expect(next?.phase).toBe("signed")
    expect((await store.get(OWNER))?.phase).toBe("signed")
    expect(await store.update(`0x${"99".repeat(20)}`, (current) => current)).toBeNull()
    const kept = await store.update(OWNER, () => null)
    expect(kept?.phase).toBe("signed")
  })

  it("refuses to save a record the next load could not read", async () => {
    const { entries, store } = rotationsOver()
    await store.put(record())
    const bad = { ...record({ phase: "signed" }), createdAt: 1n } as unknown as BackupRotationRecord
    await expect(store.put(bad)).rejects.toBeInstanceOf(WalletError)
    await expect(store.update(OWNER, () => bad)).rejects.toBeInstanceOf(WalletError)
    expect((await rotationsOver(entries).store.get(OWNER))?.phase).toBe("created")
  })

  it("writes nothing when the change throws", async () => {
    const { store } = rotationsOver()
    const aborted = new AbortController()
    aborted.abort()
    await expect(
      store.update(OWNER, () => {
        aborted.signal.throwIfAborted()
        return record()
      }),
    ).rejects.toBeDefined()
    expect(await store.get(OWNER)).toBeNull()
  })

  it("shows each committed change in its view", async () => {
    const { store } = rotationsOver()
    await loadRecords(store.view)
    const seen: number[] = []
    store.view.subscribe(() => seen.push(store.view.get().records.length))
    await store.put(record())
    await store.remove(OWNER)
    expect(seen).toEqual([1, 0])
  })
})

describe("the backup rotation storage migration", () => {
  it("carries nothing without a blob", async () => {
    const { entries, store } = rotationsOver()
    expect(await loadRecords(store.view)).toEqual([])
    expect(savedKeys(entries)).toEqual([])
  })

  it("carries every record, its sealed envelopes byte for byte, and keeps the blob", async () => {
    const signed = record({ phase: "signed" })
    const other = record({ owner: addr(0x22), plan: undefined, rotation: undefined })
    const text = JSON.stringify({ [OWNER.toLowerCase()]: signed, [addr(0x22)]: other })
    const { entries, store } = rotationsOver(new Map([[LEGACY, text]]))
    const carried = await loadRecords(store.view)
    expect(carried).toHaveLength(2)
    const saved = await store.get(OWNER)
    expect(saved).toEqual(signed)
    expect(saved?.backup.envelopeHex).toBe(signed.backup.envelopeHex)
    expect(saved?.rotation?.add.envelope).toBe(signed.rotation?.add.envelope)
    const raw = entries.get(`${NS}acct/backupRotations/${OWNER.toLowerCase()}`)!
    expect(raw).toContain(`"envelopeHex":"${signed.backup.envelopeHex!}"`)
    expect(raw).toContain(`"envelope":"${signed.rotation!.add.envelope!}"`)
    expect(entries.get(LEGACY)).toBe(text)
  })

  it("carries a finished record without its envelope, signature and salt", async () => {
    const finished = stripSettled(
      record({ phase: "done", fundings: [funding({ outcome: "swept" })] }),
    )
    const { store } = rotationsOver(new Map([[LEGACY, blob(OWNER.toLowerCase(), finished)]]))
    expect(await store.get(OWNER)).toEqual(finished)
  })

  it.each([
    ["does not parse", '{"0x11": {"owner": "0x11", "attemptId": "a'],
    ["is empty", ""],
    ["is a list", "[]"],
  ])("fails the open, writing nothing and keeping the bytes, when the blob %s", async (_, text) => {
    const { entries, store } = rotationsOver(new Map([[LEGACY, text]]))
    await expect(store.ready).rejects.toBeDefined()
    await expectClosed(store)
    expect([...entries]).toEqual([[LEGACY, text]])
  })

  it("fails the open, writing nothing, over one record that does not read", async () => {
    const key = OWNER.toLowerCase()
    for (const value of [...damaged(), record({ owner: addr(0x99) })]) {
      const text = JSON.stringify({ [addr(0x22)]: record({ owner: addr(0x22) }), [key]: value })
      const { entries, store } = rotationsOver(new Map([[LEGACY, text]]))
      await expect(store.ready).rejects.toBeDefined()
      await expectClosed(store)
      expect([...entries]).toEqual([[LEGACY, text]])
    }
  })
})

describe("stripSettled", () => {
  it("drops the signature and the envelope, and the salt once every funding was swept or lost", () => {
    const done = stripSettled(record({ phase: "done", fundings: [funding({ outcome: "swept" })] }))
    expect(done.backup.envelopeHex).toBeUndefined()
    expect(done.rotation?.signature).toBeUndefined()
    expect(done.rotation?.add.envelope).toBeUndefined()
    expect(done.rotation?.sharedSecretSalt).toBeUndefined()
    expect(done.rotation?.sipa).toBe(addr(20))
    expect(done.rotation?.deployArgs.intentHash).toBe(word(17))
    expect(done.fromBlock).toBe(record().fromBlock)
  })

  it("keeps the salt while a funding is final with no sweep to take it", () => {
    const landing = stripSettled(
      record({ phase: "done", fundings: [funding({ outcome: "mined" })] }),
    )
    expect(landing.rotation?.sharedSecretSalt).toBe(word(9))
    expect(landing.rotation?.signature).toBeUndefined()
  })

  it("keeps the salt while a listed funding is still pending, and drops it once it resolves", () => {
    const open = stripSettled(
      record({
        phase: "done",
        fundings: [funding({ outcome: "mined" }), funding({ attemptId: "attempt-2" })],
      }),
    )
    expect(open.rotation?.sharedSecretSalt).toBe(word(9))
    expect(open.rotation?.signature).toBeUndefined()
    const resolved = stripSettled({
      ...open,
      fundings: open.fundings.map((f) => ({ ...f, outcome: "dead" as const })),
    })
    expect(resolved.rotation?.sharedSecretSalt).toBeUndefined()
  })

  it("keeps the salt while money sits unswept at the deposit address", () => {
    const parked = stripSettled(
      record({
        phase: "attention",
        attention: "stranded",
        suspended: "done",
        unswept: true,
        fundings: [funding({ outcome: "swept" })],
      }),
    )
    expect(parked.rotation?.sharedSecretSalt).toBe(word(9))
    expect(parked.rotation?.signature).toBeUndefined()
    expect(
      stripSettled({ ...parked, unswept: undefined }).rotation?.sharedSecretSalt,
    ).toBeUndefined()
  })

  it("keeps the salt while the sweep is re-read, and drops it once the re-check ends", () => {
    const sweep = { index: "3", blockNumber: 90, blockHash: word(42), credited: "1400" }
    const done = (over: Partial<typeof sweep> & { recheck?: "gone" | "deep" | "lost" }) =>
      stripSettled(
        record({
          phase: "done",
          fundings: [funding({ outcome: "swept" })],
          sweep: { ...sweep, ...over },
        }),
      ).rotation?.sharedSecretSalt
    expect(done({})).toBe(word(9))
    expect(done({ recheck: "gone" })).toBe(word(9))
    expect(done({ recheck: "deep" })).toBeUndefined()
    expect(done({ recheck: "lost" })).toBeUndefined()
    expect(done({ blockNumber: undefined })).toBeUndefined()
  })

  it("leaves a record with no rotation as it is, minus the envelope", () => {
    const r = record({ phase: "created", rotation: undefined, plan: undefined })
    expect(stripSettled(r)).toEqual({ ...r, backup: { ...r.backup, envelopeHex: undefined } })
  })
})

describe("the stored rotation", () => {
  it("round-trips the sdk's rotation through JSON", () => {
    const persisted = persistedRotation(stored())
    expect(persisted.nonce).toBe(7n)
    expect(persisted.intent.rollupVersion).toBe(6n)
    expect(persisted.builtOver.publicKey).toEqual({ x: 11n, y: 12n })
    expect(persisted.sharedSecretSalt).toBeInstanceOf(Fr)
    expect(persisted.sharedSecretSalt.toString()).toBe(word(9))
    expect(persisted.deployArgs.rollupVersion).toBe(6n)
    expect(JSON.parse(JSON.stringify(storeRotation(persisted)))).toEqual(stored())
  })

  it("refuses to rebuild a rotation whose salt, signature or envelope left the record", () => {
    expect(() => persistedRotation(stored({ sharedSecretSalt: undefined }))).toThrow(
      RotationStrippedError,
    )
    expect(() => persistedRotation(stored({ signature: undefined }))).toThrow("signature")
    expect(() =>
      persistedRotation(stored({ add: { ...stored().add, envelope: undefined } })),
    ).toThrow("envelope")
  })
})

describe("moveProgress", () => {
  it("counts the latest run's included or mined chunks over its plan", () => {
    const chunk = (state: "planned" | "submitted" | "included" | "mined") => ({
      token: "t",
      amount: "1",
      state,
    })
    expect(moveProgress({ move: undefined })).toBeUndefined()
    expect(
      moveProgress({
        move: {
          runs: [
            { plannedAt: 1, m: 1, depositBound: false, chunks: [chunk("mined")] },
            {
              plannedAt: 2,
              m: 3,
              depositBound: true,
              chunks: [chunk("mined"), chunk("included"), chunk("submitted")],
            },
          ],
        },
      }),
    ).toEqual({ included: 2, total: 3, depositBound: true })
  })

  it("counts an included chunk whose transfer reverted as nothing moved", () => {
    const chunk = { token: "t", amount: "1", state: "included" as const }
    expect(
      moveProgress({
        move: {
          runs: [
            {
              plannedAt: 1,
              m: 2,
              depositBound: false,
              chunks: [chunk, { ...chunk, effect: "reverted" }],
            },
          ],
        },
      }),
    ).toEqual({ included: 1, total: 2, depositBound: false })
  })
})

describe("refundProgress", () => {
  it("counts the links taken back or spent another way while one has yet to land", () => {
    expect(refundProgress({ refunds: undefined })).toBeUndefined()
    expect(
      refundProgress({
        refunds: {
          links: [
            { link: "a", state: "mined" },
            { link: "b", state: "skipped" },
            { link: "c", state: "included", effect: "reverted" },
            { link: "d", state: "planned" },
          ],
        },
      }),
    ).toEqual({ landed: 2, total: 4 })
    expect(
      refundProgress({
        refunds: {
          links: [
            { link: "a", state: "included" },
            { link: "b", state: "skipped" },
          ],
        },
      }),
    ).toBeUndefined()
  })
})

describe("moveDeclined", () => {
  it("holds over a declined refund as over a declined chunk, while the move runs", () => {
    const refunds = { declined: true as const, links: [{ link: "a", state: "planned" as const }] }
    expect(moveDeclined({ phase: "rerooted", refunds })).toBe(true)
    expect(moveDeclined({ phase: "done", refunds })).toBe(false)
    expect(moveDeclined({ phase: "rerooted", refunds: { links: refunds.links } })).toBe(false)
  })
})

describe("rerootAhead", () => {
  const at = (phase: BackupRotationPhase, over: Partial<BackupRotationRecord> = {}) =>
    rerootAhead({ phase, ...over })

  it("holds from the backup's creation until the re-root switches the wallet", () => {
    for (const phase of ["created", "signed", "published", "funded"] as const) {
      expect(at(phase)).toBe(true)
    }
    expect(at("swept")).toBe(true)
    expect(at("installed", { reroot: { batch: "0x01" } })).toBe(true)
    expect(at("swept", { reroot: { switched: true } })).toBe(false)
    expect(at("installed", { reroot: { switched: true } })).toBe(false)
  })

  it("ends once the wallet runs on the two-key account, or the rotation will not run", () => {
    for (const phase of ["rerooted", "moved", "done", "conflict", "recovered"] as const) {
      expect(at(phase)).toBe(false)
    }
  })

  it("reads an attention by the phase it interrupted", () => {
    expect(at("attention", { attention: "route", suspended: "published" })).toBe(true)
    expect(at("attention", { attention: "move", suspended: "rerooted" })).toBe(false)
    expect(at("attention", { attention: "corrupt" })).toBe(false)
  })
})

describe("movesBalance", () => {
  it("holds from the re-root's switch until the move ends", () => {
    for (const phase of ["created", "signed", "published", "funded", "swept", "installed"] as const)
      expect(movesBalance({ phase })).toBe(false)
    for (const phase of ["swept", "installed"] as const) {
      expect(movesBalance({ phase, reroot: { batch: word(1) } })).toBe(false)
      expect(movesBalance({ phase, reroot: { switched: true } })).toBe(true)
    }
    expect(movesBalance({ phase: "rerooted" })).toBe(true)
    expect(movesBalance({ phase: "moved" })).toBe(true)
    for (const phase of ["done", "recovered", "conflict"] as const)
      expect(movesBalance({ phase, reroot: { switched: true } })).toBe(false)
  })

  it("lets a move parked for the user hold nothing", () => {
    expect(movesBalance({ phase: "attention", reroot: { switched: true } })).toBe(false)
  })
})
