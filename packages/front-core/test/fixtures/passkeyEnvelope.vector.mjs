// Writes passkeyEnvelope.vector.json beside itself with node:crypto alone, never with the module
// under test, so the test pins the HKDF info, the AAD order and the account encoding independently.
//   node test/fixtures/passkeyEnvelope.vector.mjs
import { createCipheriv, hkdfSync } from "node:crypto"
import { writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const hex = (bytes) => `0x${Buffer.from(bytes).toString("hex")}`
const fromHex = (h) => Buffer.from(h.slice(2), "hex")

const prf = fromHex(`0x${"5a".repeat(16)}${"a5".repeat(16)}`)
const masterKey = fromHex(`0x${"0f".repeat(31)}01`)
const nonce = fromHex(`0x${"0c".repeat(12)}`)
const account = "0x1111111111111111111111111111111111111111"
const credentialId = "AQIDBAUGBwgJCgsMDQ4PEBESExQ" // the 20 bytes 0x01..0x14
const slot = "second"

const kek = Buffer.from(
  hkdfSync("sha256", prf, Buffer.alloc(0), Buffer.from("zk.money/passkey-envelope/v1"), 32),
)
const cipher = createCipheriv("aes-256-gcm", kek, nonce)
cipher.setAAD(Buffer.concat([fromHex(account), Buffer.from(credentialId, "base64url")]))
const ciphertext = Buffer.concat([cipher.update(masterKey), cipher.final()])
const tag = cipher.getAuthTag()
const envelope = Buffer.concat([
  Buffer.from([0x01, slot === "first" ? 0x00 : 0x01]),
  nonce,
  ciphertext,
  tag,
])

writeFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "passkeyEnvelope.vector.json"),
  JSON.stringify(
    {
      prfHex: hex(prf),
      slot,
      masterKeyHex: hex(masterKey),
      account,
      credentialId,
      nonceHex: hex(nonce),
      envelopeHex: hex(envelope),
    },
    null,
    2,
  ) + "\n",
)
