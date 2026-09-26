// @vitest-environment node
/**
 * Offline SIPA CREATE2 (ERC-1167 clone-with-immutable-args) — two pins:
 *  1. the derivation matches an independent viem reconstruction of the OZ 5.6.1
 *     clone init code (a different code path from the Buffer assembly under test),
 *  2. (LIVE_OXIDE=1) the derivation matches the deployed `Registry.predictSIPA`
 *     on Sepolia, using that factory's own `implementationFor` and the
 *     deposit intentHash — deployer = the Registry. The local-Solidity equivalent
 *     runs in `sipaAddress.anvil.test.ts`.
 */

import { describe, expect, it } from "vitest"
import {
  createPublicClient,
  encodeAbiParameters,
  encodePacked,
  getContractAddress,
  http,
  parseAbiParameters,
  type Hex,
  type PublicClient,
} from "viem"
import { EthAddress } from "@aztec/foundation/eth-address"
import { extractPinnedOxideEnvTuple } from "@obsidion/core/oxide"
import { predictSIPA, readDepositSIPAImplementation } from "@obsidion/sdk"
import { computeSIPAAddress } from "../../../../src/core/services/deposits/sipa"

const INPUTS = {
  sipaFactory: EthAddress.fromString("0x0b903b955dbc0c97252f1ce9e43f8c26e8f5635f"),
  implementation: EthAddress.fromString("0x39dd57b9f2b16e5c9e9e35e18b73c8a2a5d1f7c4"),
  intentHash: Buffer.from(
    "2d2b85117fb7b9c18c24f74d964a952070dc83713469c0493c8ac1bcbed0e171",
    "hex",
  ),
  recoveryAddress: EthAddress.fromString("0xfd9df8ea9d7350063da52e60e7e1b6d78449786a"),
  rollupVersion: 4127419662n,
  resweepable: false,
}

/** Independent viem reconstruction of the OZ `Clones._cloneCodeWithImmutableArgs` init code. */
function cloneInitCode(implementation: EthAddress, args: Hex): Hex {
  const argsByteLength = (args.length - 2) / 2
  return encodePacked(
    ["bytes1", "uint16", "bytes17", "address", "bytes15", "bytes"],
    [
      "0x61",
      argsByteLength + 0x2d,
      "0x3d81600a3d39f3363d3d373d3d3d363d73",
      implementation.toString() as `0x${string}`,
      "0x5af43d82803e903d91602b57fd5bf3",
      args,
    ],
  )
}

function abiEncodedArgs(inputs: typeof INPUTS): Hex {
  return encodeAbiParameters(parseAbiParameters("bytes32, address, uint256, bool"), [
    `0x${inputs.intentHash.toString("hex")}`,
    inputs.recoveryAddress.toString() as `0x${string}`,
    inputs.rollupVersion,
    inputs.resweepable,
  ])
}

describe("computeSIPAAddress (ERC-1167 clone)", () => {
  it("matches an independent viem CREATE2 over the clone init code (deployer = SIPAFactory, salt = 0)", () => {
    const expected = getContractAddress({
      opcode: "CREATE2",
      from: INPUTS.sipaFactory.toString() as `0x${string}`,
      salt: `0x${"00".repeat(32)}`,
      bytecode: cloneInitCode(INPUTS.implementation, abiEncodedArgs(INPUTS)),
    })
    expect(computeSIPAAddress(INPUTS).toString()).toBe(expected.toLowerCase())
  })

  it("is sensitive to the implementation and every immutable arg", () => {
    const base = computeSIPAAddress(INPUTS).toString()
    expect(
      computeSIPAAddress({
        ...INPUTS,
        implementation: EthAddress.fromString("0x239474855dff1eb58dca3ee877d599e3c6bd0bd2"),
      }).toString(),
    ).not.toBe(base)
    expect(computeSIPAAddress({ ...INPUTS, intentHash: Buffer.alloc(32, 1) }).toString()).not.toBe(
      base,
    )
    expect(computeSIPAAddress({ ...INPUTS, resweepable: true }).toString()).not.toBe(base)
    expect(
      computeSIPAAddress({ ...INPUTS, rollupVersion: INPUTS.rollupVersion + 1n }).toString(),
    ).not.toBe(base)
    expect(
      computeSIPAAddress({
        ...INPUTS,
        sipaFactory: EthAddress.fromString("0x239474855dff1eb58dca3ee877d599e3c6bd0bd2"),
      }).toString(),
    ).not.toBe(base)
  })

  /**
   * Two sandbox generations of one rollup version, from a real portal roll: same factory, same
   * rollup version, same intent — only the implementation differs, and the two SIPAs are different
   * addresses. `SIPAFactory` keeps one forward pointer per rollup version and the later blessing
   * overwrites it, so a retired generation's SIPA is reachable only through the implementation that
   * generation published. GENERATION_A's address is the one that held the deposit; deriving the
   * same note against GENERATION_C's implementation reads an address nothing was ever sent to.
   */
  it("puts one rollup version's two generations at different addresses", () => {
    const rolled = {
      ...INPUTS,
      sipaFactory: EthAddress.fromString("0x9d4454b023096f34b160d6b654540c56a1f81688"),
      intentHash: Buffer.from(
        "c493a14e74c21b283959e52d05f602454837493ccf9d0416f161e5baeefaa2cf",
        "hex",
      ),
      recoveryAddress: EthAddress.fromString("0xe118d9d8866ca6bfa5abc6301a74857ba854baf1"),
      rollupVersion: 3685977955n,
      resweepable: true,
    }
    const generationA = EthAddress.fromString("0x7969c5ed335650692bc04293b07f5bf2e7a673c0")
    const generationC = EthAddress.fromString("0x02df3a3f960393f5b349e40a599feda91a7cc1a7")

    expect(computeSIPAAddress({ ...rolled, implementation: generationA }).toString()).toBe(
      "0x18910ce5ac36eb3a6e65a9605ac2602fdc879bc1",
    )
    expect(computeSIPAAddress({ ...rolled, implementation: generationC }).toString()).toBe(
      "0x8c9c6e8134ce978f753dc22597b8bd80f11fb498",
    )
  })
})

const LIVE_MANIFEST_URL =
  process.env.OXIDE_MANIFEST_URL ?? "https://d1162cdsa8f9md.cloudfront.net/dev.v4.json"
const LIVE_PORTAL = process.env.OXIDE_PORTAL

describe.runIf(process.env.LIVE_OXIDE === "1")("live predictSIPA parity", () => {
  it("offline derivation equals the deployed SIPAFactory.predictSIPA", async () => {
    if (!LIVE_PORTAL) throw new Error("LIVE_OXIDE=1 needs OXIDE_PORTAL")
    const manifest = await (await fetch(LIVE_MANIFEST_URL)).json()
    const { tuple } = extractPinnedOxideEnvTuple(manifest, { portal: LIVE_PORTAL })
    if (!tuple.sipaFactory || !tuple.portal) {
      throw new Error("live dev.json lacks the SIPA surface")
    }
    const client = createPublicClient({
      transport: http(process.env.SEPOLIA_RPC_URL ?? "https://ethereum-sepolia-rpc.publicnode.com"),
    }) as PublicClient

    const implementation = await readDepositSIPAImplementation(
      client,
      tuple.sipaFactory as `0x${string}`,
      tuple.portal as `0x${string}`,
    )
    const inputs = {
      ...INPUTS,
      sipaFactory: EthAddress.fromString(tuple.sipaFactory),
      implementation: EthAddress.fromString(implementation),
      rollupVersion: BigInt(tuple.rollupVersion),
    }
    const onChain = await predictSIPA(
      client as never,
      tuple.sipaFactory as never,
      inputs.implementation.toString() as never,
      `0x${inputs.intentHash.toString("hex")}` as never,
      inputs.recoveryAddress.toString() as never,
      inputs.rollupVersion,
      inputs.resweepable,
    )
    expect(computeSIPAAddress(inputs).toString()).toBe(onChain.toLowerCase())
  }, 60_000)
})
