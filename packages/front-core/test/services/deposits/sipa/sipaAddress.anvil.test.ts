// @vitest-environment node
/**
 * Deployed-registry SIPA parity for the ERC-1167 clone derivation, intent shape. Reads the deployed
 * Registry's SIPA implementation and asserts the offline `computeSIPAAddress` reconstructs the same
 * address an independent viem CREATE2 over the OZ 5.6.1 clone init code does, for two intents: a
 * deposit-shaped `intentHash` and a registration commitment (`keccak256(registrationData)`).
 *
 * Phase-4: restores the on-chain `Registry.predictSIPA(implementation, intentHash, …)` comparison and
 * splits the read into the distinct DepositSIPA / RegistrationSIPA implementations. On the pre-rework
 * base the registry exposes a single shared implementation, so both intents derive over it here.
 *
 * Gated on `SIPA_ANVIL_RPC_URL` (e.g. `http://127.0.0.1:8545`) so the default `pnpm test` neither
 * reads L1 nor requires a running anvil. Registry / expected impl overridable via
 * `SIPA_REGISTRY_ADDRESS` / `SIPA_EXPECTED_IMPL`.
 */

import { describe, expect, it } from "vitest"
import {
  createPublicClient,
  encodeAbiParameters,
  encodePacked,
  getContractAddress,
  http,
  parseAbiParameters,
  type Address,
  type Hex,
  type PublicClient,
} from "viem"
import { foundry } from "viem/chains"
import { EthAddress } from "@aztec/foundation/eth-address"
import { computeSIPAAddress } from "../../../../src/core/services/deposits/sipa"
import {
  encodeRegistrationData,
  registrationCommitment,
} from "../../../../src/oxide/oxideRegistrationData"
import type { RegistrationRecord } from "@obsidion/core/types"

// The shared sandbox's registration stack (see the task brief); override for another deployment.
const REGISTRY = (process.env.SIPA_REGISTRY_ADDRESS ??
  "0x10ec7842a2c21f1c74ba180f4ee63fc0fc3ac8e5") as Address
const EXPECTED_IMPL = (
  process.env.SIPA_EXPECTED_IMPL ?? "0xd4A5496Ee18948e403F0DA62d3538FfcD367a129"
).toLowerCase()

const REGISTRY_ABI = [
  {
    type: "function",
    name: "sipaImplementation",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "address" }],
  },
] as const

const BASE = {
  recoveryAddress: EthAddress.fromString("0xfd9df8ea9d7350063da52e60e7e1b6d78449786a"),
  rollupVersion: 4127419662n,
}

// A representative record, so the registration `intentHash` is a real keccak256(registrationData).
const RECORD: RegistrationRecord = {
  nameHash: `0x${"11".repeat(32)}`,
  owner: "0x00000000000000000000000000000000000000a1",
  publicKey: { x: 5n, y: 7n },
  l2Address: `0x${"cd".repeat(32)}`,
  resolver: "0x00000000000000000000000000000000000000e0",
  rollupVersion: BASE.rollupVersion,
  fee: 1n,
  beneficiary: "0x00000000000000000000000000000000000000b5",
  recipientCommitment: `0x${"ef".repeat(32)}`,
  namePortalRecipient: `0x${"00".repeat(32)}`,
}

/** Independent viem reconstruction of the OZ `Clones._cloneCodeWithImmutableArgs` init code. */
function cloneInitCode(implementation: Address, args: Hex): Hex {
  const argsByteLength = (args.length - 2) / 2
  return encodePacked(
    ["bytes1", "uint16", "bytes17", "address", "bytes15", "bytes"],
    [
      "0x61",
      argsByteLength + 0x2d,
      "0x3d81600a3d39f3363d3d373d3d3d363d73",
      implementation,
      "0x5af43d82803e903d91602b57fd5bf3",
      args,
    ],
  )
}

/** abi.encode(SIPA.Args) — the four intent-shape words, `intentHash` first. */
function abiEncodedArgs(intentHash: Buffer, resweepable: boolean): Hex {
  return encodeAbiParameters(parseAbiParameters("bytes32, address, uint256, bool"), [
    `0x${intentHash.toString("hex")}` as Hex,
    BASE.recoveryAddress.toString() as `0x${string}`,
    BASE.rollupVersion,
    resweepable,
  ])
}

describe.runIf(!!process.env.SIPA_ANVIL_RPC_URL)("SIPA parity against the deployed Registry", () => {
  const rpc = process.env.SIPA_ANVIL_RPC_URL as string
  const publicClient = createPublicClient({ chain: foundry, transport: http(rpc) }) as PublicClient

  const offline = (impl: Address, intentHash: Buffer, resweepable: boolean) =>
    computeSIPAAddress({
      registry: EthAddress.fromString(REGISTRY),
      implementation: EthAddress.fromString(impl),
      intentHash,
      ...BASE,
      resweepable,
    })

  const viemAddress = (impl: Address, intentHash: Buffer, resweepable: boolean) =>
    getContractAddress({
      opcode: "CREATE2",
      from: REGISTRY as `0x${string}`,
      salt: `0x${"00".repeat(32)}`,
      bytecode: cloneInitCode(impl, abiEncodedArgs(intentHash, resweepable)),
    }).toLowerCase()

  const readImpl = () =>
    publicClient.readContract({
      address: REGISTRY,
      abi: REGISTRY_ABI,
      functionName: "sipaImplementation",
    }) as Promise<Address>

  it("uses the expected deployed SIPA implementation", async () => {
    expect((await readImpl()).toLowerCase()).toBe(EXPECTED_IMPL)
  })

  it("offline == viem CREATE2 for a deposit intent", async () => {
    const impl = await readImpl()
    const intentHash = Buffer.from(
      "2d2b85117fb7b9c18c24f74d964a952070dc83713469c0493c8ac1bcbed0e171",
      "hex",
    )
    expect(offline(impl, intentHash, true).toString()).toBe(viemAddress(impl, intentHash, true))
  })

  it("offline == viem CREATE2 for a registration intent (intentHash = keccak256(record))", async () => {
    const impl = await readImpl()
    const commitment = registrationCommitment(RECORD)
    // Sanity: the commitment is keccak256 of the encoded record.
    expect(commitment).toHaveLength(66)
    expect(encodeRegistrationData(RECORD)).toHaveLength(2 + 576)
    const intentHash = Buffer.from(commitment.slice(2), "hex")
    // A registration SIPA is one-shot (resweepable = false).
    expect(offline(impl, intentHash, false).toString()).toBe(viemAddress(impl, intentHash, false))
  }, 30_000)
})
