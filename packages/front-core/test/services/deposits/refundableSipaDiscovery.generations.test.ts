// @vitest-environment node
/**
 * The historic residual probe's derivation, unmocked, over two generations of ONE rollup version —
 * the shape a sandbox portal roll produces and the shape that hid a funded deposit: the two
 * generations share a factory, a rollup version and an event set, and differ only in the deposit
 * implementation they published. Deriving both against a single implementation collapses them onto
 * the same addresses, which is what taking one generation's implementation for the other would do.
 */
import { describe, expect, it } from "vitest"
import { AztecAddress } from "@aztec/aztec.js/addresses"
import { Fr } from "@aztec/aztec.js/fields"
import type { OxideEnvTuple } from "@obsidion/core/types"
import { deriveRefundableSipaSources } from "../../../src/core/services/deposits/refundableSipaDiscovery"
import { deriveStealthKey } from "../../../src/oxide/oxideAccountKeys"

const RECIPIENT = AztecAddress.fromStringUnsafe("0x" + "00".repeat(30) + "1234")
const STEALTH_KEY = deriveStealthKey(new Fr(5)).publicKey
const EVENTS = [
  { messageSecret: new Fr(11).toString(), resweepable: true },
  { messageSecret: new Fr(12).toString(), resweepable: false },
]

/** Both generations of the roll: everything a SIPA address commits to is shared but the impl. */
const generation = (depositSIPAImplementation: string): OxideEnvTuple =>
  ({
    version: "v4",
    gitSha: "local",
    timestamp: "2026-09-05T13:06:36.398Z",
    portal: "0x1fa02b2d6a771842690194cf62d91bdd92bfe28d",
    token: "0x0e801d84fa97b50751dbf25036d067dcf18858bf",
    l2Token: "0x" + "77".repeat(32),
    enclaveUrl: "http://enclave.invalid/rpc",
    pcr0: "",
    rollupVersion: "3685977955",
    sipaFactory: "0x9d4454b023096f34b160d6b654540c56a1f81688",
    depositSIPAImplementation,
  } as OxideEnvTuple)

const derive = (tuple: OxideEnvTuple) =>
  deriveRefundableSipaSources({
    events: EVENTS,
    recipientL2Address: RECIPIENT.toString(),
    stealthPublicKey: STEALTH_KEY,
    tuple,
  })

describe("deriveRefundableSipaSources across a portal roll", () => {
  it("gives each generation its own SIPA addresses", async () => {
    const a = await derive(generation("0x7969c5ed335650692bc04293b07f5bf2e7a673c0"))
    const c = await derive(generation("0x02df3a3f960393f5b349e40a599feda91a7cc1a7"))

    expect(a.map((s) => s.sipaAddress)).toHaveLength(EVENTS.length)
    expect(a.map((s) => s.sipaAddress)).not.toEqual(c.map((s) => s.sipaAddress))
    for (const source of a) {
      expect(c.map((s) => s.sipaAddress)).not.toContain(source.sipaAddress)
    }
  })

  it("is stable for one generation — the same events derive the same addresses", async () => {
    const impl = "0x7969c5ed335650692bc04293b07f5bf2e7a673c0"
    expect((await derive(generation(impl))).map((s) => s.sipaAddress)).toEqual(
      (await derive(generation(impl))).map((s) => s.sipaAddress),
    )
  })
})
