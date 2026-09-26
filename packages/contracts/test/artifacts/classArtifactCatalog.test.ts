import { createHash } from "node:crypto"
import { expect, it, vi } from "vitest"
import { AztecAddress } from "@aztec/stdlib/aztec-address"
import { getContractClassFromArtifact } from "@aztec/stdlib/contract"
import raw from "../../src/artifacts/lazy/broadcaster_contract.js"
import { getBroadcasterArtifact, getHardcodedArtifact } from "../../src/services/utils.js"
import {
  createClassArtifactResolver,
  resolveInstanceArtifact,
} from "../../src/services/classArtifactCatalog.js"
import { DEFAULT_CONTRACTS } from "@obsidion/core/constants"

const bytes = Buffer.from(JSON.stringify(raw))
const sha256 = createHash("sha256").update(bytes).digest("hex")
const artifact = await getBroadcasterArtifact()
const classId = (await getContractClassFromArtifact(artifact)).id.toString()
const url = "https://artifacts.example/broadcaster.json"
const catalog = { [classId]: { url, sha256 } }

it("loads and caches the exact reviewed historical class", async () => {
  const fetcher = vi.fn<typeof fetch>(async () => new Response(bytes))
  const resolve = createClassArtifactResolver(catalog, fetcher)
  const [a, b] = await Promise.all([resolve(classId), resolve(classId)])
  expect(a).toBe(b)
  expect((await getContractClassFromArtifact(a)).id.toString()).toBe(classId)
  expect(fetcher).toHaveBeenCalledTimes(1)
  expect(fetcher.mock.calls[0]?.[1]).toMatchObject({ redirect: "error" })
})

it("accepts a lazy manifest pin resolver", async () => {
  const pin = vi.fn(async () => catalog[classId]!)
  const fetcher = vi.fn<typeof fetch>(async () => new Response(bytes))
  const resolve = createClassArtifactResolver(pin, fetcher)
  const [a, b] = await Promise.all([resolve(classId), resolve(classId)])
  expect(a).toBe(b)
  expect(pin).toHaveBeenCalledTimes(1)
  expect(fetcher).toHaveBeenCalledTimes(1)
})

it("rejects changed bytes and permits a checked retry", async () => {
  const fetcher = vi
    .fn()
    .mockResolvedValueOnce(new Response("changed"))
    .mockResolvedValueOnce(new Response(bytes))
  const resolve = createClassArtifactResolver(catalog, fetcher)
  await expect(resolve(classId)).rejects.toThrow("checksum")
  await expect(resolve(classId)).resolves.toBeDefined()
})

it("rejects an unreviewed class, a wrong class and credential-bearing URLs", async () => {
  const other = AztecAddress.fromBigIntUnsafe(3n).toString()
  await expect(createClassArtifactResolver(catalog)(other)).rejects.toThrow("No reviewed artifact")
  await expect(
    createClassArtifactResolver(
      { [other]: { url, sha256 } },
      async () => new Response(bytes),
    )(other),
  ).rejects.toThrow("class differs")
  await expect(
    createClassArtifactResolver({
      [classId]: { url: "https://user:password@artifacts.example/a", sha256 },
    })(classId),
  ).rejects.toThrow("without credentials")
})

it("selects the source instance class instead of the current bundled class", async () => {
  const node = {
    getContract: async () => ({ currentContractClassId: { toString: () => classId } }),
  }
  const resolve = createClassArtifactResolver(catalog, async () => new Response(bytes))
  const loaded = await resolveInstanceArtifact(
    node,
    AztecAddress.fromBigIntUnsafe(10n),
    () => getHardcodedArtifact(DEFAULT_CONTRACTS.claimFpc),
    resolve,
  )
  expect((await getContractClassFromArtifact(loaded)).id.toString()).toBe(classId)
  await expect(
    resolveInstanceArtifact(
      node,
      AztecAddress.fromBigIntUnsafe(10n),
      () => getHardcodedArtifact(DEFAULT_CONTRACTS.claimFpc),
      () => getHardcodedArtifact(DEFAULT_CONTRACTS.claimFpc),
    ),
  ).rejects.toThrow("class differs")
})
