import { beforeEach, describe, expect, it, vi } from "vitest"

const chain = vi.hoisted(() => ({
  state: "0xsigned-over" as string,
  uses: 0,
  order: [] as string[],
  prepareMetadataUpdate: vi.fn(),
}))
vi.mock("../../src/services/metadataMigration.js", async (original) => ({
  ...(await original<typeof import("../../src/services/metadataMigration.js")>()),
  readMetadataUpdateFee: async () => 5n,
  readOrdinaryDepositFee: async () => 2n,
  readMetadataDestinationState: async () => chain.state,
  assertMetadataUpdateFresh: async () => {},
  prepareMetadataUpdate: chain.prepareMetadataUpdate,
}))
vi.mock("../../src/services/migrationBootstrap.js", () => ({
  prepareMigrationBootstrap: async () => ({ payload: {}, sendOptions: {} }),
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
  decodeMetadataUpdateProofs: () => "0xconsent",
  decodeMetadataUpdateIntentData: () => ({
    metadata: "0xrecord",
    owner: OWNER,
    metadataRegistry: REGISTRY,
    recipientCommitment: "0xrecipient",
    namePortalRecipient: FPC,
    namePortal: NAME_PORTAL,
    rollupVersion: 7n,
    expectedStateHash: "0xsigned-over",
  }),
}))

import { WITHDRAW_RELAYER_TIP } from "@obsidion/core/constants"
import { StalePlanError } from "../../src/services/metadataMigration.js"
import {
  MetadataMigrationService,
  type MetadataMigrationSource,
} from "../../src/services/MetadataMigrationService.js"

const OWNER = "0x00000000000000000000000000000000000000a1"
const REGISTRY = "0x00000000000000000000000000000000000000a2"
const NAME_PORTAL = "0x00000000000000000000000000000000000000a3"
const FPC = "0x00000000000000000000000000000000000000a4"
const SIPA = "0x00000000000000000000000000000000000000a5"

function fixture(options: object = {}) {
  const fpc = { equals: () => true, toString: () => FPC }
  const source = {
    identity: "frozen-source",
    state: vi.fn(async () => "frozen" as const),
    prepare: vi.fn(
      async (_sipa: string, _minimum: bigint, onSelected?: (id: string) => Promise<void>) => {
        await onSelected?.("batch-1")
        chain.order.push("batch approval")
        return { id: "batch-1", netAmount: 10n, operation: { proven: true } }
      },
    ),
    restore: vi.fn(async () => {
      chain.order.push("batch rebuilt")
      return { netAmount: 10n, operation: { proven: true } }
    }),
    prepareRemaining: vi.fn(async () => {
      chain.order.push("later batches")
    }),
  }
  const resolve = vi.fn(async () => ({
    recipientHash: { toString: () => "0xrecipient" },
    recoveryCommitment: { toString: () => "0xrecovery" },
    messageSecret: { toString: () => "0xsecret" },
  }))
  const service = new MetadataMigrationService({
    source: source as unknown as MetadataMigrationSource,
    owner: OWNER,
    record: { rollupVersion: 7n },
    destination: {
      rollupVersion: 7n,
      metadataRegistry: REGISTRY,
      namePortal: NAME_PORTAL,
      implementation: SIPA,
    },
    bootstrap: { fpcAddress: fpc, user: fpc, railId: 0 },
    registered: { fpcAddress: fpc, user: fpc, railId: 1 },
    selfResolver: { resolve },
    wallet: { node: { getNodeInfo: async () => ({ rollupVersion: 7 }) } },
    client: { getBlockNumber: async () => 100n },
    nameClaim: async () => ({ kind: "nameClaim" }),
    signConsent: async () => "0xconsent",
    ...options,
  } as never)
  const drafts: string[] = []
  const saveDraft = vi.fn(async (draft: string) => {
    drafts.push(draft)
    chain.order.push(`draft ${Object.keys(JSON.parse(draft)).join(",")}`)
  })
  return { service, source, resolve, drafts, saveDraft }
}

beforeEach(() => {
  chain.state = "0xsigned-over"
  chain.uses = 0
  chain.order = []
  chain.prepareMetadataUpdate.mockReset()
  chain.prepareMetadataUpdate.mockImplementation(
    async (args: { signConsent(d: string): unknown }) => {
      chain.order.push("consent")
      await args.signConsent("0xdigest")
      return { sipa: SIPA, fee: 5n, intentData: "0xintent", proofs: "0xproofs" }
    },
  )
})

describe("preparing an upgrade", () => {
  it("saves its coordinates before the consent and its batch before that batch's approval", async () => {
    const { service, saveDraft } = fixture()

    await service.prepare(undefined, saveDraft)

    expect(chain.order).toEqual([
      "draft day,nonce",
      "consent",
      "draft day,nonce,sourceBatch",
      "batch approval",
      "later batches",
    ])
  })

  it("counts every approval before the first, the consent first", async () => {
    const { service, source } = fixture()
    Object.assign(source, {
      quote: async () => ({ movable: 30n, stranded: 0n, waiting: 0n, batches: 3 }),
    })
    source.prepareRemaining.mockImplementation(
      async (_minimum: bigint, opts: { onApproval(a: number, t: number): Promise<void> }) => {
        await opts.onApproval(0, 2)
        await opts.onApproval(1, 2)
        await opts.onApproval(2, 2)
      },
    )
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
      [0, 4],
      [1, 4],
      [2, 4],
      [2, 4],
      [3, 4],
      [4, 4],
    ])
  })

  it("quotes the approvals and fees preparing then asks for", async () => {
    const { service, source } = fixture()
    Object.assign(source, {
      quote: async () => ({ movable: 30n, stranded: 0n, waiting: 0n, batches: 3 }),
    })
    const totals: number[] = []

    const quote = await service.quote()
    await service.prepare(
      undefined,
      async () => {},
      undefined,
      async (_approved, total) => {
        totals.push(total)
      },
    )

    // The metadata fee on the first deposit, the ordinary fee on the other two, a tip on each.
    expect(quote).toMatchObject({ approvals: 4, fees: 3n * WITHDRAW_RELAYER_TIP + 5n + 2n * 2n })
    expect(totals[0]).toBe(quote.approvals)
    expect(await service.quote({ firstBatchSettled: true })).toMatchObject({
      approvals: 3,
      fees: 3n * WITHDRAW_RELAYER_TIP + 3n * 2n,
    })
  })

  it("counts no consent approval for an account that signs it with its bootstrap key", async () => {
    const { service, source } = fixture({ consentPrompts: async () => false })
    Object.assign(source, {
      quote: async () => ({ movable: 30n, stranded: 0n, waiting: 0n, batches: 3 }),
    })
    const progress: [number, number][] = []

    const quote = await service.quote()
    await service.prepare(
      undefined,
      async () => {},
      undefined,
      async (approved, total) => {
        progress.push([approved, total])
      },
    )

    expect(quote.approvals).toBe(3)
    expect(progress.slice(0, 3)).toEqual([
      [0, 3],
      [0, 3],
      [1, 3],
    ])
  })

  it("quotes every deposit at the ordinary fee when the destination record is current", async () => {
    chain.uses = 1
    chain.state = "0xcurrent"
    const { service, source } = fixture()
    Object.assign(source, {
      quote: async () => ({ movable: 30n, stranded: 0n, waiting: 0n, batches: 3 }),
    })
    const totals: number[] = []

    const quote = await service.quote()
    await service.prepare(
      undefined,
      async () => {},
      undefined,
      async (_approved, total) => {
        totals.push(total)
      },
    )

    expect(quote).toMatchObject({ approvals: 4, fees: 3n * WITHDRAW_RELAYER_TIP + 3n * 2n })
    expect(totals[0]).toBe(quote.approvals)
  })

  it("proves every later batch beside the first batch and the plan's own coordinates", async () => {
    const { service, source } = fixture()

    const plan = JSON.parse(await service.prepare(undefined, async () => {}))

    expect(source.prepareRemaining).toHaveBeenCalledWith(3n, {
      exclude: "batch-1",
      reserved: [{ day: plan.day, nonce: plan.nonce }],
      signal: undefined,
      onApproval: undefined,
    })
  })

  it("resumes a draft at its coordinates and rebuilds its saved batch", async () => {
    const { service, source, resolve, saveDraft } = fixture()

    const plan = await service.prepare(
      JSON.stringify({ day: 3, nonce: 9, sourceBatch: "batch-1" }),
      saveDraft,
    )

    expect(resolve).toHaveBeenCalledWith(expect.anything(), 3, 9, expect.anything())
    expect(source.restore).toHaveBeenCalledWith("batch-1", SIPA)
    expect(source.prepare).not.toHaveBeenCalled()
    expect(saveDraft).not.toHaveBeenCalled()
    expect(JSON.parse(plan)).toMatchObject({ day: 3, nonce: 9, sourceBatch: "batch-1" })
  })

  it("selects again when the draft's batch no longer holds", async () => {
    const { service, source, saveDraft } = fixture()
    source.restore.mockRejectedValueOnce(new StalePlanError("already been refunded"))

    await service.prepare(JSON.stringify({ day: 3, nonce: 9, sourceBatch: "gone" }), saveDraft)

    expect(source.prepare).toHaveBeenCalledOnce()
  })

  it("stops before the next approval once cancelled", async () => {
    const { service, source, saveDraft } = fixture()
    const cancel = new AbortController()
    chain.prepareMetadataUpdate.mockImplementationOnce(async () => {
      cancel.abort()
      return { sipa: SIPA, fee: 5n, intentData: "0xintent", proofs: "0xproofs" }
    })

    await expect(service.prepare(undefined, saveDraft, cancel.signal)).rejects.toThrow()

    expect(source.prepare).not.toHaveBeenCalled()
  })
})

describe("a saved plan", () => {
  const plan = (service: MetadataMigrationService) => service.prepare(undefined, async () => {})

  it("is stale before its consent is checked once the destination state moved", async () => {
    const { service } = fixture()
    const raw = await plan(service)
    const fresh = fixture().service
    chain.prepareMetadataUpdate.mockClear()
    chain.state = "0xmoved"

    await expect(fresh.ready(raw)).rejects.toBeInstanceOf(StalePlanError)

    expect(chain.prepareMetadataUpdate).not.toHaveBeenCalled()
  })

  it("after publication, approves what is missing without checking its consent again", async () => {
    const { service } = fixture()
    const raw = await service.prepare(undefined, async () => {})
    const fresh = fixture()
    chain.prepareMetadataUpdate.mockClear()
    chain.state = "0xpublished"

    await fresh.service.ready(raw, undefined, true)

    expect(chain.prepareMetadataUpdate).not.toHaveBeenCalled()
    expect(fresh.source.restore).not.toHaveBeenCalled()
    expect(fresh.source.prepareRemaining).toHaveBeenCalledOnce()
  })

  it("approves funds that reached a source that was empty when it was prepared", async () => {
    const { service, source } = fixture()
    source.state.mockResolvedValue("empty" as never)
    const raw = await service.prepare(undefined, async () => {})
    expect(JSON.parse(raw).sourceState).toBe("empty")

    await service.ready(raw, undefined, true)

    expect(source.prepareRemaining).toHaveBeenCalledOnce()
  })

  it("is rebuilt from saved approvals before publication, once", async () => {
    const { service, source } = fixture()
    const raw = await plan(service)
    const fresh = fixture()

    await fresh.service.ready(raw)
    await fresh.service.ready(raw)

    expect(fresh.source.restore).toHaveBeenCalledOnce()
    expect(source.restore).not.toHaveBeenCalled()
  })
})
