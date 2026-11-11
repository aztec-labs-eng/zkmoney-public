import { BaseError, ContractFunctionRevertedError, encodeErrorResult, parseAbi } from "viem"
import { describe, expect, it, vi } from "vitest"
import { createPace } from "@obsidion/core/cadence"
import {
  ensAddresses,
  ensNameOf,
  lookupEnsAddress,
  ensNames,
  type EnsClient,
} from "../../src/core/services/ens"
import { queries } from "../../src/engine/query"
import { memoryStore } from "../../src/engine/store"

const addr = (digit: number) => `0x${String(digit).repeat(40)}` as const
const client = (getEnsName: () => Promise<string | null>) => () =>
  ({ getEnsName } as unknown as EnsClient)
const names = (getClient: Parameters<typeof ensNames>[1]) =>
  ensNames(
    queries({ pace: createPace(), visible: memoryStore(true).readonly, now: () => Date.now() }),
    getClient,
  )

describe("ensNames", () => {
  it.each([
    ["keeps a normalized name", 1, "vitalik.eth", "vitalik.eth"],
    ["drops a name normalization changes", 2, "Vitalik.eth", null],
    ["drops a confusable name", 3, "vіtalik.eth", null],
    ["reads no record as no name", 4, null, null],
  ])("%s", async (_, digit, primary, expected) => {
    expect(await names(client(async () => primary))(addr(digit)).read()).toBe(expected)
  })

  it("fails a failed lookup and reads it again next time, and reads no registry as no name", async () => {
    const getEnsName = vi.fn<() => Promise<string | null>>()
    getEnsName.mockRejectedValueOnce(new Error("rpc")).mockResolvedValue("nick.eth")
    const lookup = names(client(getEnsName))
    await expect(lookup(addr(5)).read()).rejects.toThrow("rpc")
    expect(await lookup(addr(5)).read()).toBe("nick.eth")
    expect(await names(() => null)(addr(6)).read()).toBeNull()
  })

  it("looks an address up once", async () => {
    const getEnsName = vi.fn(async () => "nick.eth")
    const lookup = names(client(getEnsName))
    await Promise.all([1, 2].map(() => lookup(addr(7)).read()))
    await lookup(addr(7)).read()
    expect(getEnsName).toHaveBeenCalledTimes(1)
  })
})

const ADDRESS = "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045"
const abi = parseAbi(["error ResolverNotFound(bytes)", "error HttpError(uint16, string)"])
const reverted = (errorName: "ResolverNotFound" | "HttpError", args: readonly unknown[]) =>
  new BaseError("reverted", {
    cause: new ContractFunctionRevertedError({
      abi,
      functionName: "resolve",
      data: encodeErrorResult({ abi, errorName, args } as never),
    }),
  })
const forward = (getEnsAddress: () => Promise<string | null>) => () =>
  ({ getEnsAddress } as unknown as EnsClient)

describe("ensNameOf", () => {
  it("normalizes a dotted name and rejects everything else", () => {
    expect(ensNameOf("Vitalik.ETH")).toBe("vitalik.eth")
    expect(ensNameOf("0xfoo.eth")).toBe("0xfoo.eth")
    for (const text of [ADDRESS, "rainbow", "ens.", "a..eth", "vit alik.eth"])
      expect(ensNameOf(text)).toBeUndefined()
  })
})

describe("lookupEnsAddress", () => {
  it("answers the address, or null for no record, no resolver, or no ENS registry", async () => {
    expect(
      await lookupEnsAddress(
        forward(async () => ADDRESS),
        "a.eth",
      ),
    ).toBe(ADDRESS)
    expect(
      await lookupEnsAddress(
        forward(async () => null),
        "a.eth",
      ),
    ).toBeNull()
    const noResolver = forward(() => Promise.reject(reverted("ResolverNotFound", ["0x"])))
    expect(await lookupEnsAddress(noResolver, "a.eth")).toBeNull()
    expect(await lookupEnsAddress(() => null, "a.eth")).toBeNull()
  })

  it("throws when the lookup itself fails, e.g. an offchain gateway", async () => {
    const gateway = forward(() => Promise.reject(reverted("HttpError", [404, "Not Found"])))
    await expect(lookupEnsAddress(gateway, "alice.fkey.id")).rejects.toThrow()
  })
})

describe("ensAddresses", () => {
  it("looks a name up again on every read, so a stealth name never reuses an address", async () => {
    let n = 0
    const query = queries({
      pace: createPace({ signalled: false }),
      visible: memoryStore(true),
      now: () => Date.now(),
    })
    const addresses = ensAddresses(
      query,
      forward(async () => addr(++n)),
    )
    expect(await addresses("alice.fkey.id").read()).toBe(addr(1))
    expect(await addresses("alice.fkey.id").read()).toBe(addr(2))
  })
})
