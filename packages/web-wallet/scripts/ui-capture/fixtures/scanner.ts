import {
  CONNECT_FORMAT_VERSION,
  buildHandshakeLink,
  deriveBootstrapKey,
  encodeInline,
} from "@obsidion/front-core"
import { decodePaylinkInline, encodePaylinkInline } from "@obsidion/sdk"
import { captureSession } from "./control"
import { demoClaimFragments } from "../../../src/dev/demoFixtures"
import { entryPath } from "./data"

/** Test-only corpus through production encoders. It does not register contacts or submit funds. */
export async function scannerCorpus() {
  const session = captureSession()
  const masterSecret = await session.auth.getSecretKey()
  if (!masterSecret) throw new Error("Seed the local demo wallet first")
  const paylink = demoClaimFragments().direct
  // A link is complete before its deposit lands, so the prepared form is the same fragment.
  const preparedPaylink = decodePaylinkInline(paylink)
  return {
    connect: buildHandshakeLink(
      `https://${"preview".repeat(9)}.${"branch".repeat(10)}.zk.money`,
      encodeInline({
        version: `${CONNECT_FORMAT_VERSION}:${session.page.config.network}`,
        kind: "handshake",
        xmtpHandle: deriveBootstrapKey(masterSecret).address,
        uuid: "00000000-0000-4000-8000-000000000001",
        time: Date.now(),
        tag: "a".repeat(31),
        l2Address: `0x${"17".repeat(32)}`,
      }),
    ),
    paylink: `/link#${paylink}`,
    preparedPaylink: `/link#${encodePaylinkInline(preparedPaylink)}`,
    request: entryPath("request"),
  }
}
export async function scannerContacts() { return (await captureSession().contacts?.all()) ?? [] }
