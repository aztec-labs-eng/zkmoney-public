/**
 * A frozen portal refunds an open payment link's notes to its creator under the escrow's fallback
 * key. Pure key derivation over the real escrow artifact; no PXE, no node.
 */
import { describe, expect, it, vi } from "vitest"
import { readFileSync } from "fs"
import { resolve } from "path"
import { Fr, Point } from "@aztec/aztec.js/fields"
import { TxHash } from "@aztec/stdlib/tx"
import { loadContractArtifact } from "@aztec/stdlib/abi"
import {
  CompleteAddress,
  getContractClassFromArtifact,
  getContractInstanceFromInstantiationParams,
} from "@aztec/stdlib/contract"
import type { NoirCompiledContract } from "@aztec/stdlib/noir"
import { deriveRefundOwnerAddress } from "@oxide/oxide-lib/refund_authorization.js"
import { DEFAULT_CONTRACTS } from "@obsidion/contracts"
import { PaylinkService, type CreatedPaylinkParams } from "../../src/services/PaylinkService.js"
import {
  discoverFrozenEscrows,
  paylinkRefundOwner,
} from "../../src/services/paylink/frozenEscrows.js"
import {
  deriveDeterministicPaylinkKeys,
  derivePaylinkKeys,
} from "../../src/services/paylink/paylinkKeys.js"
import { decodeTransferMeta } from "../../src/services/transferMeta.js"
import type { ScannedTransferEvent } from "../../src/services/transferEventSource.js"

const registerEscrow = vi.hoisted(() => vi.fn())
vi.mock("../../src/services/paylink/escrowRegistration.js", () => ({ registerEscrow }))

const ARTIFACT = loadContractArtifact(
  JSON.parse(
    readFileSync(
      resolve(
        __dirname,
        "../../../contracts/src/artifacts/target/paylink_direct/paylink_direct-PaylinkDirect.json",
      ),
      "utf-8",
    ),
  ) as NoirCompiledContract,
)
const escrowOf = (keys: {
  publicKeys: Awaited<ReturnType<typeof derivePaylinkKeys>>["publicKeys"]
}) =>
  getContractInstanceFromInstantiationParams(ARTIFACT, {
    salt: new Fr(0n),
    publicKeys: keys.publicKeys,
  })

describe("paylinkRefundOwner", () => {
  it("authorizes with the creator's fallback key, under the escrow's own address", async () => {
    const keys = await deriveDeterministicPaylinkKeys(
      Fr.random(),
      20_000,
      0,
      DEFAULT_CONTRACTS.paylinkDirect,
    )
    const escrow = await escrowOf(keys)
    const owner = await paylinkRefundOwner(escrow, keys, keys.fallbackSecret!)
    expect(owner!.authorizer.kind).toBe("fallbackKey")
    expect((await deriveRefundOwnerAddress(owner!)).equals(escrow.address)).toBe(true)
    expect(await paylinkRefundOwner(escrow, keys, Fr.random())).toBeUndefined()
  })
})

describe("discoverFrozenEscrows", () => {
  async function fixture() {
    const creator = (await CompleteAddress.fromSecretKeyAndPartialAddress(Fr.random(), Fr.random()))
      .address
    const contractService = {
      getArtifactForContract: async () => ARTIFACT,
      getArtifactForClass: async () => ARTIFACT,
      getKnownClassIds: async () => [(await getContractClassFromArtifact(ARTIFACT)).id.toString()],
    }
    const service = new PaylinkService(
      { getNodeIdentity: async () => ({ l1ChainId: 31337, rollupVersion: 1 }) } as never,
      { getAddress: () => creator } as never,
      null as never,
      contractService as never,
    )
    const masterSecret = Fr.random()
    registerEscrow.mockReset().mockImplementation(async (_deps, link: CreatedPaylinkParams) => {
      const keys = await derivePaylinkKeys({
        secretKey: link.secret,
        fallbackKeyHash: link.fallbackKeyHash,
      })
      return { instance: await escrowOf(keys), keys, artifact: ARTIFACT }
    })
    const lane = async (n: number, from = creator.toString()): Promise<ScannedTransferEvent> => {
      const keys = await deriveDeterministicPaylinkKeys(
        masterSecret,
        20_000,
        n,
        DEFAULT_CONTRACTS.paylinkDirect,
      )
      return {
        txHash: `0x${n}`,
        from,
        to: (await escrowOf(keys)).address.toString(),
        amount: "1000000",
        blockNumber: 7,
        ...decodeTransferMeta(
          service.depositMeta(DEFAULT_CONTRACTS.paylinkDirect, { paylinkKeys: keys }),
        ),
      }
    }
    const discoverFrom = (
      events: Parameters<typeof discoverFrozenEscrows>[0]["events"],
      hints: CreatedPaylinkParams[] = [],
    ) =>
      discoverFrozenEscrows({
        paylinkService: {
          recoverPaylinkFromTransfer: service.recoverPaylinkFromTransfer.bind(service),
        },
        escrows: { wallet: {}, contractService } as never,
        events,
        account: creator,
        masterSecret,
        hints,
      })
    const discover = (events: ScannedTransferEvent[], hints: CreatedPaylinkParams[] = []) =>
      discoverFrom({ headBlock: async () => 9, listIncoming: async () => events }, hints)
    return { creator, discover, discoverFrom, lane }
  }

  it("finds the account's links from its funding transfers and from hints, each escrow once", async () => {
    const { discover, lane } = await fixture()
    const own = await lane(0)
    const recovered = await discover([own])
    // A bring-your-own-keys link announces no lane; its row is the hint.
    const byo = await derivePaylinkKeys({ secretKey: Fr.random(), fallbackSecret: Fr.random() })
    const hint = {
      secret: byo.secretKey,
      fallbackKeyHash: byo.fallbackKeyHash,
      fallbackSecret: byo.fallbackSecret!,
      paylinkType: DEFAULT_CONTRACTS.paylinkDirect,
      classId: (await escrowOf(byo)).currentContractClassId,
    } as CreatedPaylinkParams
    registerEscrow.mockClear()
    const escrows = await discover([own, await lane(1, Fr.random().toString())], [hint])
    expect(escrows.map((e) => e.owner.address.toString())).toEqual([
      recovered[0]!.owner.address.toString(),
      (await escrowOf(byo)).address.toString(),
    ])
    expect(registerEscrow).toHaveBeenCalledTimes(2)
    // A row for a link its lane already found is not rebuilt again.
    registerEscrow.mockClear()
    await discover(
      [own],
      [
        {
          ...hint,
          secret: own.paylinkCreated!.secret,
          fallbackKeyHash: own.paylinkCreated!.fallbackKeyHash,
          classId: (await getContractClassFromArtifact(ARTIFACT)).id,
        },
      ],
    )
    expect(registerEscrow).toHaveBeenCalledTimes(1)
  })

  it("keeps two links that share a secret but not a fallback key as two escrows", async () => {
    const { discover } = await fixture()
    const secretKey = Fr.random()
    const hints = await Promise.all(
      [Fr.random(), Fr.random()].map(async (fallbackSecret) => {
        const keys = await derivePaylinkKeys({ secretKey, fallbackSecret })
        return {
          secret: secretKey,
          fallbackKeyHash: keys.fallbackKeyHash,
          fallbackSecret,
          paylinkType: DEFAULT_CONTRACTS.paylinkDirect,
          classId: (await escrowOf(keys)).currentContractClassId,
        } as CreatedPaylinkParams
      }),
    )
    expect(new Set((await discover([], hints)).map((e) => e.owner.address.toString())).size).toBe(2)
  })

  it("spends each frozen note with the transaction that created it, not the link's deposit", async () => {
    const { discover, lane } = await fixture()
    const [escrow] = await discover([await lane(0)])
    // Another transfer to the escrow before the freeze.
    const later = TxHash.random()
    const metadata = await escrow!.resolveSpendMetadata({
      owner: escrow!.owner.address,
      creationTxHash: later,
    } as never)
    expect(metadata.creationTxHash.equals(later)).toBe(true)
  })

  it("skips a link whose funding transfer does not rebuild its escrow, as the rescan does", async () => {
    const { discover, lane } = await fixture()
    const own = await lane(0)
    const escrows = await discover([own, { ...own, txHash: "0xbad", to: (await lane(1)).to }])
    expect(escrows.map((e) => e.owner.address.toString())).toEqual([own.to])
  })

  it("skips a hint whose own material does not rebuild its escrow", async () => {
    const { discover } = await fixture()
    const hint = async () => {
      const keys = await derivePaylinkKeys({ secretKey: Fr.random(), fallbackSecret: Fr.random() })
      return {
        secret: keys.secretKey,
        fallbackKeyHash: keys.fallbackKeyHash,
        fallbackSecret: keys.fallbackSecret!,
        paylinkType: DEFAULT_CONTRACTS.paylinkDirect,
        classId: (await escrowOf(keys)).currentContractClassId,
      } as CreatedPaylinkParams
    }
    const good = await hint()
    const escrows = await discover(
      [],
      [
        { ...(await hint()), classId: Fr.random() },
        { ...(await hint()), escrowTagSecret: Point.INFINITY },
        { ...(await hint()), fallbackSecret: Fr.random() },
        good,
      ],
    )
    expect(escrows.map((e) => e.owner.address.toString())).toEqual([
      (
        await escrowOf(
          await derivePaylinkKeys({ secretKey: good.secret, fallbackSecret: good.fallbackSecret }),
        )
      ).address.toString(),
    ])
  })

  it("uses a good copy of a link when an earlier copy of it doesn't rebuild its escrow", async () => {
    const { discover } = await fixture()
    const keys = await derivePaylinkKeys({ secretKey: Fr.random(), fallbackSecret: Fr.random() })
    const good = {
      secret: keys.secretKey,
      fallbackKeyHash: keys.fallbackKeyHash,
      fallbackSecret: keys.fallbackSecret!,
      paylinkType: DEFAULT_CONTRACTS.paylinkDirect,
      classId: (await escrowOf(keys)).currentContractClassId,
    } as CreatedPaylinkParams
    const escrows = await discover([], [{ ...good, fallbackSecret: Fr.random() }, good])
    expect(escrows.map((e) => e.owner.address.toString())).toEqual([
      (await escrowOf(keys)).address.toString(),
    ])
  })

  it("throws when the transfer scan fails, so a scan is never partial", async () => {
    const { discoverFrom } = await fixture()
    await expect(
      discoverFrom({
        headBlock: async () => 9,
        listIncoming: async () => {
          throw new Error("node down")
        },
      }),
    ).rejects.toThrow("node down")
  })
})
