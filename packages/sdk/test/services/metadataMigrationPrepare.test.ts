import { beforeEach, describe, expect, it, vi } from "vitest"

const chain = vi.hoisted(() => ({
  state: "0xsigned-over" as string,
  uses: 0,
  order: [] as string[],
  prepareRecordUpdate: vi.fn(),
  check: vi.fn(),
  bootstrap: vi.fn(async (..._args: unknown[]) => ({ payload: { built: true }, sendOptions: {} })),
}))
vi.mock("../../src/services/metadataMigration.js", async (original) => ({
  ...(await original<typeof import("../../src/services/metadataMigration.js")>()),
  readMetadataDestinationState: async () => chain.state,
  prepareRecordUpdate: chain.prepareRecordUpdate,
  restoreRecordUpdate: async (raw: string) => JSON.parse(raw),
  checkRecordUpdate: chain.check,
}))
vi.mock("../../src/services/migrationBootstrap.js", () => ({
  prepareMigrationBootstrap: chain.bootstrap,
  claimFpcIdentitySubscribed: async () => false,
}))
vi.mock("../../src/services/claimSponsor.js", () => ({
  claimFpcSubscriptionUses: async () => chain.uses,
  hasClaimFpcSubscription: async () => false,
}))
vi.mock("@oxide/l1-contracts", async (original) => ({
  ...(await original<typeof import("@oxide/l1-contracts")>()),
  encodeUserRecordMetadata: () => "0xrecord",
  userRecordStateHash: () => "0xcurrent",
}))

import { StalePlanError } from "../../src/services/metadataMigration.js"
import {
  MetadataMigrationService,
  type MetadataMigrationSource,
} from "../../src/services/MetadataMigrationService.js"

const OWNER = "0x00000000000000000000000000000000000000a1"
const REGISTRY = "0x00000000000000000000000000000000000000a2"
const NAME_PORTAL = "0x00000000000000000000000000000000000000a3"
const FPC = "0x00000000000000000000000000000000000000a4"
const PASSKEY = { qx: "0x01", qy: "0x02" }

type Progress = (approved: number, total: number) => Promise<void>

/** The registration run's source is this version: it holds nothing to move. */
function fixture(options: object = {}) {
  const fpc = { equals: () => true, toString: () => FPC }
  const source = {
    identity: "no-source-deployment",
    state: vi.fn(async (): Promise<"frozen" | "empty"> => "empty"),
  }
  const signRecordUpdate = vi.fn(async (_userOpHash: string, _stateHash: string) => "0xassertion")
  const sendTx = vi.fn(
    async (_payload: unknown, opts: { onTxHash(hash: string): Promise<void> }) => {
      await opts.onTxHash("0xtx")
    },
  )
  const service = new MetadataMigrationService({
    source: source as unknown as MetadataMigrationSource,
    owner: OWNER,
    record: { rollupVersion: 7n },
    destination: {
      token: "0x00000000000000000000000000000000000000b0",
      rollupVersion: 7n,
      metadataRegistry: REGISTRY,
      namePortal: NAME_PORTAL,
    },
    bootstrap: { fpcAddress: fpc, user: fpc, railId: 0 },
    registered: { fpcAddress: fpc, user: fpc, railId: 1 },
    wallet: { node: { getNodeInfo: async () => ({ rollupVersion: 7 }) }, sendTx },
    client: { getBlockNumber: async () => 100n },
    nameClaim: async () => ({ kind: "nameClaim" }),
    recordPasskey: PASSKEY,
    signRecordUpdate,
    ...options,
  } as never)
  const saveDraft = vi.fn(async (draft: string) => {
    chain.order.push(`draft ${Object.keys(JSON.parse(draft)).join(",")}`)
  })
  return { service, source, fpc, signRecordUpdate, sendTx, saveDraft }
}

/** A frozen source moves only funds, by its own batches. */
function fundsOnly(options: object = {}) {
  const f = fixture(options)
  const prepareRemaining = vi.fn(async (opts: { signal?: AbortSignal; onApproval?: Progress }) => {
    opts.signal?.throwIfAborted()
    chain.order.push("batches")
  })
  Object.assign(f.source, { identity: "frozen-source", fundsOnly: true, prepareRemaining })
  f.source.state.mockResolvedValue("frozen")
  return { ...f, prepareRemaining }
}

beforeEach(() => {
  chain.state = "0xsigned-over"
  chain.uses = 0
  chain.order = []
  chain.bootstrap.mockClear()
  chain.prepareRecordUpdate.mockReset()
  chain.prepareRecordUpdate.mockImplementation(
    async (args: { sign(userOpHash: string, stateHash: string): Promise<unknown> }) => {
      chain.order.push("record update")
      const assertion = await args.sign("0xophash", chain.state)
      return {
        update: { userOpHash: "0xophash" },
        expectedStateHash: chain.state,
        assertion,
        operation: { built: true },
      }
    },
  )
  chain.check.mockReset()
  chain.check.mockImplementation(
    async (_client: unknown, _destination: unknown, signed: { expectedStateHash: string }) => {
      chain.order.push("check")
      if (signed.expectedStateHash !== chain.state)
        throw new StalePlanError("The account's record changed; prepare the upgrade again")
      return { ...signed, operation: { built: true } }
    },
  )
})

describe("preparing the registration run", () => {
  it("saves its coordinates, then signs the record update that its bootstrap broadcasts", async () => {
    const { service, saveDraft, signRecordUpdate, fpc } = fixture()

    const plan = JSON.parse(await service.prepare(undefined, saveDraft))

    expect(chain.order).toEqual(["draft day,nonce", "record update"])
    expect(chain.prepareRecordUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ owner: OWNER, fpc, passkey: PASSKEY }),
    )
    expect(signRecordUpdate).toHaveBeenCalledWith("0xophash", "0xsigned-over")
    expect(plan).toMatchObject({ sourceState: "empty", fromBlock: "100" })
    expect(plan).not.toHaveProperty("recoveryOnly")
    expect(JSON.parse(plan.recordUpdate)).toMatchObject({
      update: { userOpHash: "0xophash" },
      expectedStateHash: "0xsigned-over",
      assertion: "0xassertion",
    })
    expect(chain.bootstrap).toHaveBeenCalledWith(
      expect.objectContaining({
        recordUpdate: expect.objectContaining({ assertion: "0xassertion" }),
        sponsorship: { kind: "bootstrap", gate: { kind: "nameClaim" } },
      }),
    )
  })

  it("counts the record update as its one approval", async () => {
    const { service } = fixture()
    const progress: [number, number][] = []

    await service.prepare(
      undefined,
      async () => {},
      undefined,
      async (approved, total) => {
        progress.push([approved, total])
        if (!approved) expect(chain.order).toEqual([])
      },
    )

    expect(progress).toEqual([
      [0, 1],
      [1, 1],
    ])
  })

  it("signs no record update while the record is current with recurring sponsorship", async () => {
    chain.uses = 1
    chain.state = "0xcurrent"
    const { service, signRecordUpdate } = fixture()
    const progress: [number, number][] = []

    const plan = JSON.parse(
      await service.prepare(
        undefined,
        async () => {},
        undefined,
        async (approved, total) => void progress.push([approved, total]),
      ),
    )

    expect(progress).toEqual([
      [0, 0],
      [0, 0],
    ])
    expect(plan).not.toHaveProperty("recordUpdate")
    expect(chain.prepareRecordUpdate).not.toHaveBeenCalled()
    expect(signRecordUpdate).not.toHaveBeenCalled()
    expect(chain.bootstrap).not.toHaveBeenCalled()
  })

  // The registration run quotes no source, so its sheet counts the record update alone.
  it("counts the record update as one approval until the record is current with recurring sponsorship", async () => {
    expect(await fixture().service.consentApprovals()).toBe(1)
    chain.state = "0xcurrent"
    expect(await fixture().service.consentApprovals()).toBe(1)
    chain.uses = 1
    expect(await fixture().service.consentApprovals()).toBe(0)
    chain.state = "0xstale"
    expect(await fixture().service.consentApprovals()).toBe(1)
  })

  it("resumes a draft at its coordinates", async () => {
    const { service, saveDraft } = fixture()

    const plan = await service.prepare(JSON.stringify({ day: 3, nonce: 9 }), saveDraft)

    expect(saveDraft).not.toHaveBeenCalled()
    expect(JSON.parse(plan)).toMatchObject({ day: 3, nonce: 9 })
  })

  it("stops before its bootstrap is built once cancelled", async () => {
    const { service, saveDraft } = fixture()
    const cancel = new AbortController()
    chain.prepareRecordUpdate.mockImplementationOnce(async () => {
      cancel.abort()
      return { update: {}, expectedStateHash: chain.state, assertion: "0x", operation: {} }
    })

    await expect(service.prepare(undefined, saveDraft, cancel.signal)).rejects.toThrow()

    expect(chain.bootstrap).not.toHaveBeenCalled()
  })

  it("refuses to update the record from a frozen source, which moves only funds", async () => {
    const { service, source } = fixture()
    source.state.mockResolvedValue("frozen")

    await expect(service.prepare()).rejects.toThrow("moves only funds")

    expect(chain.prepareRecordUpdate).not.toHaveBeenCalled()
  })
})

describe("a saved registration plan", () => {
  const plan = (service: MetadataMigrationService) => service.prepare(undefined, async () => {})

  it("is stale before publication once the destination record moved", async () => {
    const raw = await plan(fixture().service)
    const fresh = fixture()
    chain.bootstrap.mockClear()
    chain.state = "0xmoved"

    await expect(fresh.service.ready(raw)).rejects.toBeInstanceOf(StalePlanError)

    expect(chain.bootstrap).not.toHaveBeenCalled()
  })

  it("after publication, does not check its record update again", async () => {
    const raw = await plan(fixture().service)
    const fresh = fixture()
    chain.state = "0xpublished"

    await fresh.service.ready(raw, undefined, true)

    expect(chain.check).not.toHaveBeenCalled()
  })

  it("is rebuilt from its signed record update before publication, once, and checked each time", async () => {
    const fresh = fixture()
    const raw = await plan(fixture().service)
    chain.bootstrap.mockClear()

    await fresh.service.ready(raw)
    await fresh.service.ready(raw)

    expect(chain.check).toHaveBeenCalledTimes(2)
    expect(chain.bootstrap).toHaveBeenCalledOnce()
  })

  it("is stale before publication once the record moved after it was prepared here", async () => {
    const { service } = fixture()
    const raw = await plan(service)
    chain.state = "0xmoved"

    await expect(service.ready(raw)).rejects.toBeInstanceOf(StalePlanError)
  })

  it("broadcasts its prepared transaction, checking the record update again at the hash", async () => {
    const { service, sendTx } = fixture()
    const raw = await plan(service)
    const onTxHash = vi.fn(async (hash: string) => void chain.order.push(`hash ${hash}`))
    chain.order = []

    await service.broadcast(raw, onTxHash)

    expect(sendTx).toHaveBeenCalledWith({ built: true }, expect.anything())
    expect(chain.order).toEqual(["check", "check", "hash 0xtx"])
  })

  it("records no hash once the record update went stale during the send", async () => {
    const { service, sendTx } = fixture()
    const raw = await plan(service)
    sendTx.mockImplementationOnce(async (_payload, opts) => {
      chain.state = "0xmoved"
      await opts.onTxHash("0xtx")
    })
    const onTxHash = vi.fn(async () => {})

    await expect(service.broadcast(raw, onTxHash)).rejects.toBeInstanceOf(StalePlanError)

    expect(onTxHash).not.toHaveBeenCalled()
  })

  it("is stale to broadcast once it holds no record update", async () => {
    chain.uses = 1
    chain.state = "0xcurrent"
    const { service } = fixture()
    const raw = await plan(service)

    await expect(service.broadcast(raw, async () => {})).rejects.toBeInstanceOf(StalePlanError)
  })

  it("is stale when an earlier version prepared it with a metadata-update SIPA", async () => {
    const { service } = fixture()
    const raw = JSON.stringify({
      binding: await service.binding(),
      day: 1,
      nonce: 2,
      fromBlock: "100",
      intentData: "0x1234",
      proofs: "0x5678",
      sourceState: "empty",
    })

    await expect(service.ready(raw)).rejects.toBeInstanceOf(StalePlanError)
    await expect(service.broadcast(raw, async () => {})).rejects.toBeInstanceOf(StalePlanError)
    await expect(service.observe({ plan: raw })).rejects.toBeInstanceOf(StalePlanError)
  })

  it("refuses a plan for another account or deployment", async () => {
    const { service } = fixture()
    const raw = JSON.stringify({ ...JSON.parse(await plan(service)), binding: "0xother" })

    const ready = service.ready(raw)
    await expect(ready).rejects.toThrow("account or deployment changed")
    await expect(ready).rejects.not.toBeInstanceOf(StalePlanError)
  })
})

describe("a funds-only run", () => {
  it("plans its source's batches by the source's own terms, with no record update", async () => {
    const f = fundsOnly()

    const plan = JSON.parse(await f.service.prepare())

    expect(plan).toMatchObject({ recoveryOnly: true, sourceState: "frozen" })
    expect(plan).not.toHaveProperty("recordUpdate")
    expect(chain.prepareRecordUpdate).not.toHaveBeenCalled()
    expect(chain.bootstrap).not.toHaveBeenCalled()
    // The run passes the source only the plan's own coordinates.
    expect(f.prepareRemaining).toHaveBeenCalledWith({
      reserved: [{ day: plan.day, nonce: plan.nonce }],
      signal: undefined,
      onApproval: undefined,
    })
  })

  it("collects Savings approvals before registration without signing a record update", async () => {
    const f = fundsOnly({
      depositDestination: { token: "0x00000000000000000000000000000000000000b1" },
    })
    const plan = JSON.parse(await f.service.prepare())
    expect(plan).toMatchObject({ recoveryOnly: true, sourceState: "frozen" })
    expect(chain.prepareRecordUpdate).not.toHaveBeenCalled()
    expect(f.prepareRemaining).toHaveBeenCalledOnce()
  })

  it("prepares a queue follower that registration may overtake without going stale", async () => {
    const f = fundsOnly({ recoveryOnly: true })
    const raw = await f.service.prepare()
    expect(JSON.parse(raw)).not.toHaveProperty("recordUpdate")
    chain.state = "0xcurrent"
    chain.uses = 1
    await f.service.ready(raw)
    expect(chain.check).not.toHaveBeenCalled()
    await expect(f.service.broadcast(raw, async () => {})).rejects.toThrow(
      "Asset recovery cannot broadcast",
    )
  })

  it("rejects a follower whose source is not frozen", async () => {
    const f = fundsOnly({ recoveryOnly: true })
    f.source.state.mockResolvedValue("empty")
    await expect(f.service.prepare()).rejects.toThrow("requires a frozen source")
  })

  it("passes the cancel signal and the send gate to the source's reconcile, which can send a due broadcast again", async () => {
    const f = fundsOnly()
    const reconcileRemaining = vi.fn(async (_signal?: AbortSignal, _gate?: unknown) => {})
    Object.assign(f.source, { reconcileRemaining })
    const restore = vi.fn(async () => ({}))
    Object.assign(f.service, { restore })
    const cancel = new AbortController()

    const gate = <T>(step: (operationId?: string) => Promise<T>) => step()

    await f.service.reconcileRemaining("signed-plan", cancel.signal, gate)

    expect(restore).toHaveBeenCalledWith("signed-plan")
    expect(reconcileRemaining).toHaveBeenCalledWith(cancel.signal, gate)
  })
})
