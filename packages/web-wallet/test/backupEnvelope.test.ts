// @vitest-environment node
/**
 * The wallet's envelope opener over a real assertion: the user must have been verified, the PRF
 * the assertion returned opens an envelope sealed under it in either slot, and nothing else does.
 */
import { Fr } from "@aztec-labs/aztec.js/fields"
import { MSK_PRF_SALT } from "@obsidion/core/constants"
import type { PrfSlot } from "@obsidion/core/types"
import { PasskeyEnvelopeError, sealMasterKey } from "@obsidion/front-core"
import { describe, expect, it } from "vitest"
import { openBackupEnvelope } from "../src/platform/auth/backupEnvelope"
import {
  FakePasskeyCeremony,
  type FakeCeremonyOptions,
  contextualiseLocal,
} from "./support/fakePasskeyCeremony"

const ACCOUNT = `0x${"11".repeat(20)}` as const
const ELSEWHERE = `0x${"22".repeat(20)}` as const

/** One passkey on a fake authenticator, and an assertion from it carrying both PRF slots. */
async function passkey(opts: FakeCeremonyOptions = {}) {
  const ceremony = new FakePasskeyCeremony({ route: "local", ...opts })
  const { credentialId } = await ceremony.create({
    rpId: "localhost",
    rpName: "test",
    userName: "@alice",
    prfFirstSalt: MSK_PRF_SALT,
  })
  const assert = () =>
    ceremony.assert({
      rpId: "localhost",
      challenge: new Uint8Array(32),
      credentialIds: [credentialId],
      prfFirstSalt: MSK_PRF_SALT,
      prfSecondSalt: contextualiseLocal(MSK_PRF_SALT),
    })
  /** `masterKey` sealed for this passkey under the PRF the fake returns for `slot`. */
  const seal = (masterKey: Fr, slot: PrfSlot = "first", account = ACCOUNT) =>
    sealMasterKey({
      masterKey: new Uint8Array(masterKey.toBuffer()),
      prfOutput: ceremony.prfFor(credentialId, slot),
      slot,
      account,
      credentialId,
    })
  return { ceremony, credentialId, assert, seal }
}

const open = (
  assertion: Awaited<ReturnType<FakePasskeyCeremony["assert"]>>,
  envelope: Uint8Array,
  account = ACCOUNT,
) => openBackupEnvelope(assertion, { envelope, account, credentialId: assertion.credentialId })

const failure = async (run: Promise<unknown>) => {
  const err = await run.catch((e: unknown) => e)
  expect(err).toBeInstanceOf(PasskeyEnvelopeError)
  return (err as PasskeyEnvelopeError).reason
}

describe("openBackupEnvelope", () => {
  it("opens an envelope sealed under either slot, from the assertion's own outputs", async () => {
    const { assert, seal } = await passkey()
    const masterKey = Fr.random()
    for (const slot of ["first", "second"] as const) {
      const opened = await open(await assert(), await seal(masterKey, slot))
      expect(opened.toString()).toBe(masterKey.toString())
    }
  })

  it("tries the other slot when the header's does not open it", async () => {
    const { ceremony, credentialId, assert } = await passkey()
    const masterKey = Fr.random()
    // Sealed as `first` with the value this provider hands back as `second`.
    const envelope = await sealMasterKey({
      masterKey: new Uint8Array(masterKey.toBuffer()),
      prfOutput: ceremony.prfFor(credentialId, "second"),
      slot: "first",
      account: ACCOUNT,
      credentialId,
    })
    expect((await open(await assert(), envelope)).toString()).toBe(masterKey.toString())
  })

  it("refuses an assertion without user verification, or with no readable flags", async () => {
    const { assert, seal } = await passkey({ userVerified: false })
    const envelope = await seal(Fr.random())
    expect(await failure(open(await assert(), envelope))).toBe("unverified")
    const verified = await passkey()
    const assertion = await verified.assert()
    const short = { ...assertion, authenticatorData: new Uint8Array(20) }
    expect(await failure(open(short, await verified.seal(Fr.random())))).toBe("unverified")
  })

  it("does not open an envelope sealed for another account, under another passkey's PRF, or with no PRF", async () => {
    const { assert, seal } = await passkey()
    const masterKey = Fr.random()
    expect(await failure(open(await assert(), await seal(masterKey, "first", ELSEWHERE)))).toBe(
      "decrypt",
    )
    const other = await passkey()
    expect(await failure(open(await assert(), await other.seal(masterKey)))).toBe("decrypt")
    const silent = await passkey({ prfAtAssert: false })
    expect(await failure(open(await silent.assert(), await silent.seal(masterKey)))).toBe("decrypt")
  })

  it("refuses an envelope of another layout", async () => {
    const { assert } = await passkey()
    expect(await failure(open(await assert(), new Uint8Array(10)))).toBe("version")
  })
})
