#!/usr/bin/env node
/**
 * Regenerates the `mskReductionVectors` block of test/fixtures/mskPrfParity.json with the real `Fr`, so
 * the sdk's `deriveMskFromPrfOutput` and @obsidion/passkey-web's bigint reduction are pinned to the
 * same answers at the arithmetic boundary. Run from packages/sdk after `pnpm build`; prints JSON.
 */
import { Fr } from "@aztec/aztec.js/fields"

const P = 21888242871839275222246405745257275088548364400416034343698204186575808495617n
const hex32 = (n) => n.toString(16).padStart(64, "0")

const inputs = [
  ["zero", "00".repeat(32)],
  ["one", "00".repeat(31) + "01"],
  ["p minus one", hex32(P - 1n)],
  ["p", hex32(P)],
  ["p plus one", hex32(P + 1n)],
  ["all ff", "ff".repeat(32)],
  ["leading zero bytes", "0000" + "ab".repeat(30)],
  ["high bit set", "80" + "00".repeat(31)],
]

const vectors = inputs.map(([label, prfHex]) => ({
  label,
  prfHex,
  mskHex: Fr.fromBufferReduce(Buffer.from(prfHex, "hex")).toString(),
}))
console.log(JSON.stringify(vectors, null, 2))
