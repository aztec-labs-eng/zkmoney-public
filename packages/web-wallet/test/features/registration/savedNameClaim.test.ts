/** The name-claim gate reads the NameClaim of the session it was handed, not the current one. */
import { afterEach, expect, it } from "vitest"
import type { NameClaimRecord } from "@obsidion/front-core"
import { savedNameClaim } from "../../../src/features/registration/claimSponsorship"
import { closeSession } from "../../../src/session/session"
import { seedDeviceKeys } from "../../support/page"
import { openTestSession } from "../../support/session"

const ADDRESS = `0x${"0a".repeat(32)}`
const account = { getAddress: () => ({ toString: () => ADDRESS }) } as never
const claim: NameClaimRecord = {
  address: ADDRESS,
  handle: "taga",
  signature: "0xsig",
  nonce: "1",
  deadline: "2",
  nameHash: "0xnode",
}

afterEach(closeSession)

it("reads the NameClaim of the session it is handed after another one becomes current", async () => {
  await seedDeviceKeys({ storageId: "a1" })
  const signedIn = openTestSession()
  await signedIn.nameClaims.put(claim)
  closeSession()
  await seedDeviceKeys({ storageId: null })
  const visitor = openTestSession()

  expect(visitor.namespace.id).toBeNull()
  expect(await savedNameClaim(signedIn, account)).toMatchObject(claim)
  expect(await savedNameClaim(visitor, account)).toBeUndefined()
})
