import { ContactStorage } from "@obsidion/front-core"
import { decodePaylinkInline, encodePaylinkInline } from "@obsidion/sdk"
import { getAuthService } from "../../../src/platform/auth/useAuthenticator"
import { getConfig } from "../../../src/config/env"
import { mintMyConnectLink } from "../../../src/features/contacts/myCode"
import { demoClaimFragments } from "../../../src/dev/demoFixtures"
import { entryPath } from "./data"

/** Test-only corpus through production encoders. It does not register contacts or submit funds. */
export async function scannerCorpus() {
  const masterSecret = await getAuthService().getSecretKey()
  if (!masterSecret) throw new Error("Seed the local demo wallet first")
  const paylink = demoClaimFragments().direct
  // A link is complete before its deposit lands, so the prepared form is the same fragment.
  const preparedPaylink = decodePaylinkInline(paylink)
  return {
    connect: await mintMyConnectLink({
      masterSecret, ownTag: "a".repeat(32), l2Address: `0x${"17".repeat(32)}`,
      chain: getConfig().network, origin: `https://${"preview".repeat(9)}.${"branch".repeat(10)}.zk.money`, record: async () => {},
    }),
    paylink: `/link#${paylink}`,
    preparedPaylink: `/link#${encodePaylinkInline(preparedPaylink)}`,
    request: entryPath("request"),
  }
}
export async function scannerContacts() { return ContactStorage.get().getEntries() }
