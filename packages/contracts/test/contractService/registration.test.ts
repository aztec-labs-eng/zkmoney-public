/**
 * Registering a class hashes its whole artifact, so concurrent callers for one contract, or for two
 * contracts of one class, must share the work instead of each paying it.
 */
import { describe, expect, it, vi } from "vitest"
import type { AztecAddress } from "@aztec-labs/stdlib/aztec-address"
import type { ContractArtifact } from "@aztec-labs/stdlib/abi"
import { ensureContractRegisteredInPXE } from "../../src/services/utils.js"

const ARTIFACT = { name: "Shared" } as unknown as ContractArtifact
const address = (value: string) => ({ toString: () => value } as unknown as AztecAddress)

function fresh() {
  const classes = new Set<string>()
  const instances = new Set<string>()
  let release!: () => void
  const registered = new Promise<void>((resolve) => (release = resolve))
  const pxe = {
    getContractInstance: vi.fn(async (a: { toString(): string }) =>
      instances.has(a.toString()) ? { originalContractClassId: "class-1" } : undefined,
    ),
    getContractArtifact: vi.fn(async (id: unknown) =>
      classes.has(String(id)) ? ARTIFACT : undefined,
    ),
    registerContractClass: vi.fn(async () => {
      await registered
      classes.add("class-1")
    }),
    registerContract: vi.fn(async (instance: { address: string }) => {
      instances.add(instance.address)
    }),
  }
  const node = {
    getContract: vi.fn(async (a: { toString(): string }) => ({
      address: a.toString(),
      currentContractClassId: "class-1",
      originalContractClassId: "class-1",
    })),
  }
  return { pxe, node, release }
}

describe("ensureContractRegisteredInPXE", () => {
  it("shares one registration among concurrent callers for one address", async () => {
    const { pxe, node, release } = fresh()
    const calls = [1, 2, 3].map(() =>
      ensureContractRegisteredInPXE(pxe, node, address("0xaa"), async () => ARTIFACT),
    )
    release()
    await Promise.all(calls)

    expect(node.getContract).toHaveBeenCalledTimes(1)
    expect(pxe.registerContractClass).toHaveBeenCalledTimes(1)
  })

  it("hashes a class two contracts share once when both register at the same time", async () => {
    const { pxe, node, release } = fresh()
    const calls = ["0xaa", "0xbb"].map((a) =>
      ensureContractRegisteredInPXE(pxe, node, address(a), async () => ARTIFACT),
    )
    await vi.waitFor(() => expect(node.getContract).toHaveBeenCalledTimes(2))
    release()
    await Promise.all(calls)

    expect(pxe.registerContractClass).toHaveBeenCalledTimes(1)
    expect(pxe.registerContract).toHaveBeenCalledTimes(2)
  })

  it("asks again after a registration finishes, and skips a contract the PXE holds", async () => {
    const { pxe, node, release } = fresh()
    release()
    await ensureContractRegisteredInPXE(pxe, node, address("0xaa"), async () => ARTIFACT)
    await ensureContractRegisteredInPXE(pxe, node, address("0xaa"), async () => ARTIFACT)

    expect(node.getContract).toHaveBeenCalledTimes(1)
    expect(pxe.getContractInstance).toHaveBeenCalledTimes(2)
  })
})
