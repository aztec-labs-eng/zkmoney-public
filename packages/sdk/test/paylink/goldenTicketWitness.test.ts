import { beforeEach, describe, expect, it, vi } from "vitest"
import { EthAddress } from "@aztec-labs/aztec.js/addresses"
import { Fr } from "@aztec-labs/aztec.js/fields"
import { computeUniqueNoteHash, siloNoteHash } from "@aztec-labs/stdlib/hash"

const ESCROW = 0xe5c0n
const CLASS_ID = new Fr(0xc1a55n)
const EMAIL_CLASS_ID = new Fr(0xe1a55n)
const OLDER_DIRECT = new Fr(0x01d0n)
const OLDER_EMAIL = new Fr(0x01e0n)
const h = vi.hoisted(() => ({ registerEscrow: vi.fn() }))

vi.mock("../../src/services/paylink/paylinkVoucher", () => ({ registerEscrow: h.registerEscrow }))
// A stub artifact names its class; the current direct and email artifacts carry theirs.
vi.mock("@aztec-labs/stdlib/contract", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@aztec-labs/stdlib/contract")>()),
  getContractClassFromArtifact: async (artifact: { classId?: Fr }) => ({ id: artifact.classId }),
}))

const {
  assertGoldenTicketNoteSettled,
  buildGoldenTicketWitness,
  finishGoldenTicketWitness,
  goldenTicketNullifier,
  GoldenTicketWitnessError,
  paylinkClassIds,
  prepareGoldenTicketWitness,
} = await import("../../src/services/paylink/goldenTicket")
const { registerEscrow } = await import("../../src/services/paylink/escrowRegistration")
const { LINK_CLASS_REFUSAL } = await import("../../src/services/paylink/paylinkInlineCodec")
const { AztecAddress } = await import("@aztec-labs/stdlib/aztec-address")

const AMOUNT = 3n * 10n ** 18n
const point = { x: new Fr(1n), y: new Fr(2n), isInfinite: false }
const keys = {
  publicKeys: {
    npkMHash: new Fr(3n),
    ivpkM: point,
    ovpkMHash: new Fr(4n),
    tpkMHash: new Fr(5n),
    mspkMHash: new Fr(6n),
    fbpkMHash: new Fr(7n),
  },
}
const dao = {
  noteNonce: new Fr(11n),
  noteHash: new Fr(12n),
  randomness: new Fr(13n),
  note: {
    items: [1n, 2n, AMOUNT << 128n, 4n, 5n, 6n, 0x70cn].map((v) => new Fr(v)),
  },
}

function deps(notes = [dao]) {
  const node = {
    getBlockNumber: vi.fn(async () => 42),
    getBlockData: vi.fn(async () => ({
      header: { state: { partial: { noteHashTree: { root: new Fr(0x7007n) } } } },
    })),
    getNoteHashMembershipWitness: vi.fn(async () => ({
      leafIndex: 9n,
      siblingPath: [new Fr(21n), new Fr(22n)],
    })),
  }
  return {
    wallet: { pxe: { debug: { getNotes: vi.fn(async () => notes) } }, node },
    contractService: {
      getArtifactForContract: async (name: string) => ({
        classId: name === "paylinkEmail" ? EMAIL_CLASS_ID : CLASS_ID,
      }),
      getKnownClassIds: vi.fn(async (name: string) =>
        (name === "paylinkEmail" ? [EMAIL_CLASS_ID, OLDER_EMAIL] : [CLASS_ID, OLDER_DIRECT]).map(
          String,
        ),
      ),
    },
    node,
  }
}

/** The link's escrow as `registerEscrow` resolves it, under `classId`. */
const escrowUnder = (classId: Fr) => ({
  instance: { address: AztecAddress.fromBigIntUnsafe(ESCROW), currentContractClassId: classId },
  keys,
  artifact: {},
})

const OWNER = EthAddress.fromString(`0x${"ab".repeat(20)}`)
const THRESHOLD = 2n * 10n ** 18n

describe("golden ticket witness, prepared before the owner is known", () => {
  beforeEach(() => {
    h.registerEscrow.mockReset()
    h.registerEscrow.mockResolvedValue(escrowUnder(CLASS_ID))
  })

  it("reads the note, root and path without an owner, and the nullifier from the leaf alone", async () => {
    const d = deps()
    const prepared = await prepareGoldenTicketWitness(d as never, {} as never)
    const escrow = AztecAddress.fromBigIntUnsafe(ESCROW)
    const unique = await computeUniqueNoteHash(
      dao.noteNonce,
      await siloNoteHash(escrow, dao.noteHash),
    )
    expect(prepared.blockNumber).toBe(42)
    expect(prepared.root).toEqual(new Fr(0x7007n))
    expect(prepared.amount).toBe(AMOUNT)
    expect(prepared.uniqueNoteHash).toEqual(unique)
    expect(prepared.nullifier).toEqual(await goldenTicketNullifier(unique))
    expect(prepared.inputs).not.toHaveProperty("owner")
    expect(prepared.inputs).not.toHaveProperty("threshold")
    expect(d.node.getNoteHashMembershipWitness).toHaveBeenCalledWith(42, unique)
  })

  it("binds the owner and threshold at finish, matching a one-call build", async () => {
    const prepared = await prepareGoldenTicketWitness(deps() as never, {} as never)
    const finished = finishGoldenTicketWitness(prepared, { threshold: THRESHOLD, owner: OWNER })
    expect(finished.inputs).toMatchObject({
      owner: OWNER.toField().toString(),
      threshold: `0x${THRESHOLD.toString(16)}`,
      witness: { leaf_index: "0x9" },
      class_id: CLASS_ID.toString(),
    })
    expect(finished.publicInputs).toMatchObject({
      blockNumber: 42,
      threshold: THRESHOLD,
      owner: OWNER,
    })
    const built = await buildGoldenTicketWitness(deps() as never, {} as never, {
      threshold: THRESHOLD,
      owner: OWNER,
    })
    expect(built).toEqual(finished)
  })

  it("reads the root at a pinned block", async () => {
    const d = deps()
    const prepared = await prepareGoldenTicketWitness(d as never, {} as never, { blockNumber: 40 })
    expect(prepared.blockNumber).toBe(40)
    expect(d.node.getBlockNumber).not.toHaveBeenCalled()
    expect(d.node.getBlockData).toHaveBeenCalledWith(40)
  })

  it("throws the retryable witness error while the PXE has no note", async () => {
    await expect(prepareGoldenTicketWitness(deps([]) as never, {} as never)).rejects.toBeInstanceOf(
      GoldenTicketWitnessError,
    )
  })

  it("holds a prepared note settled only while the escrow still has that note", async () => {
    const prepared = await prepareGoldenTicketWitness(deps() as never, {} as never)
    await expect(
      assertGoldenTicketNoteSettled(deps() as never, {} as never, prepared),
    ).resolves.toBeUndefined()
    // Claimed or cancelled since: the PXE no longer lists it, though the old root still holds it.
    await expect(
      assertGoldenTicketNoteSettled(deps([]) as never, {} as never, prepared),
    ).rejects.toBeInstanceOf(GoldenTicketWitnessError)
    const other = { ...dao, noteNonce: new Fr(99n) }
    await expect(
      assertGoldenTicketNoteSettled(deps([other]) as never, {} as never, prepared),
    ).rejects.toBeInstanceOf(GoldenTicketWitnessError)
  })
})

describe("golden ticket class pair", () => {
  const direct = { paylinkType: "paylinkDirect" }
  const email = { paylinkType: "paylinkEmail" }

  beforeEach(() => {
    h.registerEscrow.mockReset()
  })

  it("sends the current pair for a link under the current direct class, with no manifest read", async () => {
    h.registerEscrow.mockResolvedValue(escrowUnder(CLASS_ID))
    const d = deps()
    const prepared = await prepareGoldenTicketWitness(d as never, direct as never)
    expect(prepared.classIds).toEqual([CLASS_ID, EMAIL_CLASS_ID])
    expect(prepared.inputs).toMatchObject({
      class_ids: [CLASS_ID.toString(), EMAIL_CLASS_ID.toString()],
      class_id: CLASS_ID.toString(),
    })
    expect(d.contractService.getKnownClassIds).not.toHaveBeenCalled()
  })

  it("puts an older direct link's own class in the direct slot, as the witness and public inputs", async () => {
    h.registerEscrow.mockResolvedValue(escrowUnder(OLDER_DIRECT))
    const prepared = await prepareGoldenTicketWitness(deps() as never, direct as never)
    const ticket = finishGoldenTicketWitness(prepared, { threshold: THRESHOLD, owner: OWNER })
    expect(ticket.publicInputs.classIds).toEqual([OLDER_DIRECT, EMAIL_CLASS_ID])
    expect(ticket.inputs).toMatchObject({
      class_ids: [OLDER_DIRECT.toString(), EMAIL_CLASS_ID.toString()],
      class_id: OLDER_DIRECT.toString(),
    })
  })

  it("puts an older email link's own class in the email slot", async () => {
    const pair = await paylinkClassIds(deps().contractService, email.paylinkType, {
      currentContractClassId: OLDER_EMAIL,
    })
    expect(pair).toEqual([CLASS_ID, OLDER_EMAIL])
  })

  it("refuses a link whose class its own flavor never had, before any read", async () => {
    // A reviewed email class resolves by id alone, so a direct link can carry one.
    for (const classId of [EMAIL_CLASS_ID, OLDER_EMAIL]) {
      h.registerEscrow.mockResolvedValue(escrowUnder(classId))
      const d = deps()
      await expect(prepareGoldenTicketWitness(d as never, direct as never)).rejects.toThrow(
        LINK_CLASS_REFUSAL,
      )
      expect(d.wallet.pxe.debug.getNotes).not.toHaveBeenCalled()
      expect(d.node.getBlockNumber).not.toHaveBeenCalled()
    }
    h.registerEscrow.mockResolvedValue(escrowUnder(OLDER_DIRECT))
    await expect(prepareGoldenTicketWitness(deps() as never, email as never)).rejects.toThrow(
      LINK_CLASS_REFUSAL,
    )
  })

  it("refuses a link under a class this deployment never reviewed, before any read", async () => {
    h.registerEscrow.mockImplementation(registerEscrow)
    const d = deps()
    const contractService = {
      ...d.contractService,
      getArtifactForClass: async (classId: string) => {
        throw new Error(`No artifact for contract class ${classId}`)
      },
      getKnownClassIds: async () => [CLASS_ID.toString(), OLDER_DIRECT.toString()],
    }
    const link = {
      ...direct,
      classId: new Fr(0xbadn),
      secret: new Fr(1n),
      fallbackKeyHash: new Fr(2n),
    }
    await expect(
      prepareGoldenTicketWitness({ ...d, contractService } as never, link as never),
    ).rejects.toThrow(LINK_CLASS_REFUSAL)
    expect(d.wallet.pxe.debug.getNotes).not.toHaveBeenCalled()
    expect(d.node.getBlockNumber).not.toHaveBeenCalled()
  })
})
