/** The creation and assertion sequences at the driver level, over the fake ceremony. */
import {
  APPLE_ICLOUD_AAGUID,
  GPM_AAGUID,
  ONEPASSWORD_AAGUID,
  YUBIKEY_5_USB_A_AAGUID,
  ZERO_AAGUID,
} from "@obsidion/core/constants"
import { readdirSync, readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { bytesToHex } from "../src/ceremony/bytes.js"
import type { DevicePosture } from "../src/policy/devicePosture.js"
import {
  type ObservedCeremony,
  runPasskeyAssertion,
  runPasskeyCreation,
} from "../src/policy/drivers.js"
import { candidatesFrom } from "../src/policy/evidence.js"
import {
  PhoneRequiredError,
  RelatedOriginPasskeyError,
  passkeyWritten,
} from "../src/policy/passkeyErrors.js"
import { hmac } from "@noble/hashes/hmac"
import { sha256 as nobleSha256 } from "@noble/hashes/sha256"
import {
  FakePasskeyCeremony,
  type FakeCeremonyOptions,
  contextualiseLocal,
  fakePrf,
} from "./support/fakePasskeyCeremony.js"

/** Outside the measured set, and unknown to the name table, so a refusal cannot name it. */
const UNMEASURED = "0f0f0f0f-0f0f-0f0f-0f0f-0f0f0f0f0f0f"
/** Also outside the set, but the table knows it, so a refusal says which manager answered. */
const BITWARDEN = "d548826e-79b4-db40-a3d8-11116f7e8349"

const CHALLENGE = new Uint8Array(32).fill(9)

function create(
  posture: DevicePosture,
  fake: FakeCeremonyOptions,
  extra: {
    observe?: (event: ObservedCeremony) => void | Promise<void>
    misreportsCrossDevice?: boolean
    attachmentLabelTrusted?: boolean
    signal?: AbortSignal
  } = {},
) {
  const ceremony = new FakePasskeyCeremony(fake)
  const run = runPasskeyCreation(ceremony, {
    posture,
    rpId: "localhost",
    rpName: "zk.money",
    userName: "@alice",
    challengeForChained: () => CHALLENGE,
    ...extra,
  })
  return { ceremony, run }
}

const named = (name: string) => expect.objectContaining({ name })

describe("runPasskeyCreation", () => {
  it("laptop: a phone's answer with both slots binds first", async () => {
    const { ceremony, run } = create("laptop", { route: "cross-device" })
    const result = await run
    expect(result.slot).toBe("first")
    expect(result.chained).toBeUndefined()
    expect(bytesToHex(result.prfOutput)).toBe(
      bytesToHex(ceremony.prfFor(result.created.credentialId, "first")),
    )
    expect(ceremony.creates[0]).toMatchObject({ authenticatorAttachment: "cross-platform" })
    // Opens on the phone, and names a key so a password manager's extension stands aside.
    expect(ceremony.creates[0]!.hints).toEqual(["hybrid", "security-key"])
    expect(ceremony.creates[0]!.prfSecondSalt).toHaveLength(32)
  })

  it("phone: its own answer with both slots binds second, asking for no class and hinting both", async () => {
    const { ceremony, run } = create("phone", { route: "local" })
    const result = await run
    expect(result.slot).toBe("second")
    expect(bytesToHex(result.prfOutput)).toBe(
      bytesToHex(ceremony.prfFor(result.created.credentialId, "second")),
    )
    // No class demanded, so the sheet can offer a key; the hints name the two it may answer with.
    expect(ceremony.creates[0]!.authenticatorAttachment).toBeUndefined()
    expect(ceremony.creates[0]!.hints).toEqual(["client-device", "security-key"])
  })

  it("gives a laptop's phone five minutes to answer, and names no timeout on a phone", async () => {
    const laptop = create("laptop", { route: "cross-device" })
    await laptop.run
    expect(laptop.ceremony.creates[0]!.timeoutMs).toBe(300_000)
    const phone = create("phone", { route: "local" })
    await phone.run
    expect(phone.ceremony.creates[0]!.timeoutMs).toBeUndefined()
  })

  it("hands the caller's signal to the creation and to its follow-up prompt", async () => {
    const controller = new AbortController()
    const { ceremony, run } = create(
      "laptop",
      { route: "cross-device", prfAtCreate: false },
      { signal: controller.signal },
    )
    await run
    expect(ceremony.creates[0]!.signal).toBe(controller.signal)
    expect(ceremony.assertRequests[0]!.signal).toBe(controller.signal)
    // Without one, neither request carries a signal.
    const plain = create("laptop", { route: "cross-device", prfAtCreate: false })
    await plain.run
    expect(plain.ceremony.creates[0]!.signal).toBeUndefined()
    expect(plain.ceremony.assertRequests[0]!.signal).toBeUndefined()
  })

  it("phone: a provider answering first only is a single-salt refusal", async () => {
    const { run } = create("phone", { route: "local", secondSlot: false })
    await expect(run).rejects.toThrow(named("SingleSaltProviderError"))
  })

  it("laptop: a local answer is refused before any provider or gate", async () => {
    const { ceremony, run } = create("laptop", { route: "local", aaguid: UNMEASURED })
    await expect(run).rejects.toThrow(named("PhoneRequiredError"))
    expect(ceremony.assertRequests).toHaveLength(0)
  })

  it("phone: another device's answer at creation is refused", async () => {
    const { run } = create("phone", { route: "cross-device" })
    await expect(run).rejects.toThrow(named("LocalPasskeyRequiredError"))
  })

  it("phone: a chained assertion answered by another device is refused", async () => {
    const { ceremony, run } = create("phone", {
      route: "local",
      prfAtCreate: false,
      assertAttachment: "cross-platform",
    })
    await expect(run).rejects.toThrow(named("LocalPasskeyRequiredError"))
    expect(ceremony.assertRequests).toHaveLength(1)
  })

  it("waits for the observer on the chained phase before checking its route", async () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => (release = resolve))
    let entered!: () => void
    const observing = new Promise<void>((resolve) => (entered = resolve))
    const { run } = create(
      "laptop",
      { route: "cross-device", prfAtCreate: false, assertAttachment: "platform" },
      {
        observe: async (event) => {
          if (event.phase !== "chained") return
          entered()
          await gate
        },
      },
    )
    let settled = false
    run.then(
      () => (settled = true),
      () => (settled = true),
    )
    await observing
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(settled).toBe(false)
    release()
    await expect(run).rejects.toThrow(named("PhoneRequiredError"))
  })

  it("an observer that throws ends the ceremony with its own error before any check", async () => {
    const { ceremony, run } = create(
      "laptop",
      { route: "local", prfAtCreate: false },
      {
        observe: () => {
          throw new Error("observer down")
        },
      },
    )
    await expect(run).rejects.toThrow(/observer down/)
    expect(ceremony.assertRequests).toHaveLength(0)
  })

  it("incomplete creation chains an assertion for the same credential with the caller's challenge", async () => {
    const phases: string[] = []
    const { ceremony, run } = create(
      "laptop",
      { route: "cross-device", prfAtCreate: false, createAuthData: false },
      { observe: async (event) => void phases.push(event.phase) },
    )
    const result = await run
    expect(result.chained).toBeDefined()
    expect(ceremony.assertRequests).toHaveLength(1)
    expect(ceremony.assertRequests[0]).toMatchObject({
      credentialIds: [result.created.credentialId],
      challenge: CHALLENGE,
    })
    // Asked over the same routes as the creation.
    expect(ceremony.assertRequests[0]!.hints).toEqual(["hybrid", "security-key"])
    expect(ceremony.assertRequests[0]!.prfSecondSalt).toHaveLength(32)
    expect(phases).toEqual(["created", "chained"])
    expect(bytesToHex(result.prfOutput)).toBe(
      bytesToHex(ceremony.prfFor(result.created.credentialId, "first")),
    )
  })

  it("a security key's chained assertion goes back to the key, never to the phone sheet", async () => {
    const { ceremony, run } = create("laptop", {
      route: "cross-device",
      manager: "security-key",
      transports: ["usb"],
      backupEligible: false,
      aaguid: YUBIKEY_5_USB_A_AAGUID,
      prfAtCreate: false,
    })
    const result = await run
    expect(result.securityKey).toBe(true)
    expect(result.chained).toBeDefined()
    expect(ceremony.assertRequests).toHaveLength(1)
    expect(ceremony.assertRequests[0]).toMatchObject({
      credentialIds: [result.created.credentialId],
      hints: ["security-key"],
      transports: ["usb"],
    })
  })

  it("a chained answer from the wrong route is refused", async () => {
    const { run } = create("laptop", {
      route: "cross-device",
      prfAtCreate: false,
      assertAttachment: "platform",
    })
    await expect(run).rejects.toThrow(named("PhoneRequiredError"))
  })

  it("an unmeasured manager is refused by name before the chained assertion", async () => {
    const { ceremony, run } = create("laptop", {
      route: "cross-device",
      aaguid: BITWARDEN,
      prfAtCreate: false,
    })
    await expect(run).rejects.toMatchObject({
      name: "UnsupportedProviderError",
      kind: "manager",
      providerName: "Bitwarden",
    })
    expect(ceremony.assertRequests).toHaveLength(0)
  })

  it("refuses an unmeasured manager it cannot name, without inventing one", async () => {
    const { run } = create("laptop", { route: "cross-device", aaguid: UNMEASURED })
    await expect(run).rejects.toMatchObject({
      name: "UnsupportedProviderError",
      providerName: undefined,
    })
  })

  it("offers a security key as the alternative only where the sheet can show one", async () => {
    const failed = (posture: DevicePosture, fake: FakeCeremonyOptions) =>
      create(posture, fake).run.then(
        () => {
          throw new Error("expected a refusal")
        },
        (err: Error) => err,
      )
    const onLaptop = await failed("laptop", { route: "cross-device", aaguid: BITWARDEN })
    expect(onLaptop.message).toMatch(/security key/)
    // A phone's sheet can offer a key too, so it is a real alternative there as well.
    const onPhone = await failed("phone", { route: "local", aaguid: BITWARDEN })
    expect(onPhone.name).toBe("UnsupportedProviderError")
    expect(onPhone.message).toMatch(/security key/)
  })

  it("admits a measured manager, an absent id, and one the caller lists", async () => {
    const measured = await create("laptop", { route: "cross-device", aaguid: GPM_AAGUID }).run
    expect(measured.created.aaguid).toBe(GPM_AAGUID)
    const absent = await create("laptop", { route: "cross-device" }).run
    expect(absent.created.aaguid).toBeUndefined()
    const listed = await runPasskeyCreation(
      new FakePasskeyCeremony({ route: "cross-device", aaguid: UNMEASURED }),
      {
        posture: "laptop",
        rpId: "localhost",
        rpName: "zk.money",
        userName: "@alice",
        extraProviders: [UNMEASURED],
        challengeForChained: () => CHALLENGE,
      },
    )
    expect(listed.created.aaguid).toBe(UNMEASURED)
  })

  it("a passkey that cannot be backed up, or whose flags stay unreadable, is refused after the chain", async () => {
    const bound = create("laptop", { route: "cross-device", backupEligible: false })
    await expect(bound.run).rejects.toThrow(named("DeviceBoundPasskeyError"))
    const unknown = create("laptop", { route: "cross-device", backupEligible: "unknown" })
    await expect(unknown.run).rejects.toThrow(named("DeviceBoundPasskeyError"))
    expect(unknown.ceremony.assertRequests).toHaveLength(1)
  })

  it("no PRF at creation nor on the chained assertion is refused", async () => {
    const { run } = create("laptop", {
      route: "cross-device",
      prfAtCreate: false,
      prfAtAssert: false,
    })
    await expect(run).rejects.toThrow(named("NoPrfError"))
  })

  it("the observer sees the raw result, and is awaited, before a refusal is thrown", async () => {
    const seen: ObservedCeremony[] = []
    let settled = false
    const { run } = create(
      "laptop",
      { route: "local", aaguid: UNMEASURED },
      {
        observe: async (event) => {
          seen.push(event)
          await new Promise((resolve) => setTimeout(resolve, 5))
          settled = true
        },
      },
    )
    await expect(run).rejects.toThrow(named("PhoneRequiredError"))
    expect(settled).toBe(true)
    expect(seen).toHaveLength(1)
    expect(seen[0]!.phase).toBe("created")
    expect((seen[0]!.result as { aaguid?: string }).aaguid).toBe(UNMEASURED)
  })

  it("a laptop names the phone and a key unless the consumer's null asks for no hints", async () => {
    const { ceremony, run } = create("laptop", { route: "cross-device" }, {})
    await run
    expect(ceremony.creates[0]!.hints).toEqual(["hybrid", "security-key"])
    const quiet = new FakePasskeyCeremony({ route: "cross-device", prfAtCreate: false })
    await runPasskeyCreation(quiet, {
      posture: "laptop",
      rpId: "localhost",
      rpName: "zk.money",
      userName: "@alice",
      laptopHints: null,
      challengeForChained: () => CHALLENGE,
    })
    expect(quiet.creates[0]!.hints).toBeUndefined()
    expect(quiet.assertRequests[0]!.hints).toBeUndefined()
  })
})

describe("a browser that mislabels a cross-device answer", () => {
  /** iCloud Keychain on the phone, reached over QR, labelled as the laptop's own. */
  const applePhone = (over: FakeCeremonyOptions = {}): FakeCeremonyOptions => ({
    route: "cross-device",
    manager: "icloud",
    aaguid: APPLE_ICLOUD_AAGUID,
    transports: ["hybrid", "internal"],
    attachment: "platform",
    ...over,
  })
  const on = { misreportsCrossDevice: true }

  it("laptop: reads Apple's mislabelled answer as another device and binds first", async () => {
    const { ceremony, run } = create("laptop", applePhone(), on)
    const result = await run
    expect(result.slot).toBe("first")
    expect(result.securityKey).toBe(false)
    expect(result.created.authenticatorAttachment).toBe("cross-platform")
    expect(ceremony.assertRequests).toHaveLength(0)
    expect(bytesToHex(result.prfOutput)).toBe(
      bytesToHex(ceremony.prfFor(result.created.credentialId, "first")),
    )
  })

  it("laptop: an absent label is corrected the same way", async () => {
    const result = await create("laptop", applePhone({ attachment: null }), on).run
    expect(result.slot).toBe("first")
    expect(result.created.authenticatorAttachment).toBe("cross-platform")
  })

  it("laptop: a corrected answer missing key material or flags is refused, never followed up", async () => {
    const noPrf = create("laptop", applePhone({ prfAtCreate: false }), on)
    await expect(noPrf.run).rejects.toThrow(named("IncompleteCreationError"))
    expect(noPrf.ceremony.assertRequests).toHaveLength(0)
    const noFlags = create("laptop", applePhone({ backupEligible: "unknown" }), on)
    await expect(noFlags.run).rejects.toThrow(named("IncompleteCreationError"))
    expect(noFlags.ceremony.assertRequests).toHaveLength(0)
  })

  it("laptop: a correctly labelled Apple answer keeps the follow-up path", async () => {
    const { ceremony, run } = create(
      "laptop",
      applePhone({ attachment: "cross-platform", prfAtCreate: false }),
      on,
    )
    const result = await run
    expect(result.slot).toBe("first")
    expect(ceremony.assertRequests).toHaveLength(1)
    // And that follow-up is never corrected: a mislabelled one is refused as before.
    const chained = create(
      "laptop",
      applePhone({
        attachment: "cross-platform",
        prfAtCreate: false,
        assertAttachment: "platform",
      }),
      on,
    )
    await expect(chained.run).rejects.toThrow(named("PhoneRequiredError"))
    expect(chained.ceremony.assertRequests).toHaveLength(1)
  })

  it("laptop: the transports must include the phone route, whatever the id says", async () => {
    // A key's transports, or a browser that attests nothing about the credential.
    for (const transports of [undefined, ["internal"], ["usb"]]) {
      const { run } = create("laptop", applePhone({ route: "local", transports }), on)
      await expect(run).rejects.toThrow(named("PhoneRequiredError"))
    }
  })

  it("laptop: a local manager answer under an admitted id passes the gate and binds a cell no QR read reproduces", async () => {
    // Transports list what the credential can be reached over, not which route answered, and the
    // id is self-reported. Pinned as the accepted limit of the gate, not as a behaviour to keep.
    const local = [
      { manager: "1password", aaguid: APPLE_ICLOUD_AAGUID },
      { manager: "gpm", aaguid: APPLE_ICLOUD_AAGUID },
      { manager: "1password", aaguid: ONEPASSWORD_AAGUID },
      { manager: "gpm", aaguid: GPM_AAGUID },
    ] as const
    for (const over of local) {
      const answer = applePhone({ ...over, route: "local", transports: ["internal", "hybrid"] })
      const { run, ceremony } = create("laptop", answer, on)
      const result = await run
      expect(result.slot).toBe("first")
      const id = result.created.credentialId
      const bound = bytesToHex(result.prfOutput)
      expect(bytesToHex(ceremony.prfFor(id, "first", "cross-device"))).not.toBe(bound)
      expect(bytesToHex(ceremony.prfFor(id, "second", "cross-device"))).not.toBe(bound)
    }
  })

  it("laptop: a corrected answer's orphan is signalled for deletion when it is refused", async () => {
    const seen: { rpId: string; credentialId: string }[] = []
    vi.stubGlobal("PublicKeyCredential", {
      signalUnknownCredential: async (o: { rpId: string; credentialId: string }) => {
        seen.push(o)
      },
    })
    try {
      const { run } = create("laptop", applePhone({ prfAtCreate: false }), on)
      await expect(run).rejects.toThrow(named("IncompleteCreationError"))
      expect(seen).toHaveLength(1)
      expect(seen[0]!.rpId).toBe("localhost")
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it("laptop: without the flag the mislabel is refused as before", async () => {
    await expect(create("laptop", applePhone()).run).rejects.toThrow(named("PhoneRequiredError"))
  })

  it("laptop: 1Password and Google Password Manager on the phone are corrected too, binding the cell a Chrome QR read reproduces", async () => {
    const phones = [
      { manager: "1password", aaguid: ONEPASSWORD_AAGUID },
      { manager: "gpm", aaguid: GPM_AAGUID },
    ] as const
    for (const over of phones) {
      const { run, ceremony } = create("laptop", applePhone(over), on)
      const result = await run
      expect(result.slot).toBe("first")
      expect(ceremony.assertRequests).toHaveLength(0)
      const id = result.created.credentialId
      expect(bytesToHex(result.prfOutput)).toBe(bytesToHex(ceremony.prfFor(id, "first")))
    }
  })

  it("laptop: an absent, zero or unmeasured id is not corrected", async () => {
    for (const aaguid of [undefined, ZERO_AAGUID, BITWARDEN]) {
      const { run } = create("laptop", applePhone({ aaguid }), on)
      await expect(run).rejects.toThrow(named("PhoneRequiredError"))
    }
  })

  it("laptop: a security key is never corrected", async () => {
    const key = (over: FakeCeremonyOptions = {}) => ({
      route: "cross-device" as const,
      manager: "security-key" as const,
      transports: ["usb"],
      backupEligible: false as const,
      aaguid: YUBIKEY_5_USB_A_AAGUID,
      ...over,
    })
    await expect(create("laptop", key({ attachment: "platform" }), on).run).rejects.toThrow(
      named("PhoneRequiredError"),
    )
    // Labelled correctly, a key still chains and is held to its own class there, flag or not.
    const mixed = create("laptop", key({ prfAtCreate: false, assertAttachment: "platform" }), on)
    await expect(mixed.run).rejects.toThrow(named("SecurityKeyRequiredError"))
  })

  it("phone: nothing changes", async () => {
    const local = await create("phone", { route: "local", aaguid: APPLE_ICLOUD_AAGUID }, on).run
    expect(local.slot).toBe("second")
    expect(local.created.authenticatorAttachment).toBe("platform")
    await expect(create("phone", { route: "cross-device" }, on).run).rejects.toThrow(
      named("LocalPasskeyRequiredError"),
    )
  })

  it("the observer's object keeps the reported label; the returned one is corrected", async () => {
    const seen: ObservedCeremony[] = []
    const { run } = create("laptop", applePhone(), {
      ...on,
      observe: (event) => void seen.push(event),
    })
    const result = await run
    expect(seen).toHaveLength(1)
    expect(seen[0]!.result.authenticatorAttachment).toBe("platform")
    expect(result.created.authenticatorAttachment).toBe("cross-platform")
  })
})

describe("naming what answered a refused laptop sign-up", () => {
  const WINDOWS_HELLO_AAGUIDS = [
    "08987058-cadc-4b81-b6e1-30de50dcbe96",
    "9ddd1817-af5a-4672-a2b9-3e3dd95000a9",
    "6028b017-b1d4-4c02-b4b3-afcdafc96bb2",
  ]
  const trusted = { attachmentLabelTrusted: true }
  // A sign-up with no name to give says where to create the passkey.
  const unnamed = new PhoneRequiredError({ ceremony: "create" }).message

  it("names a password manager that answered on this device", async () => {
    const { ceremony, run } = create("laptop", { route: "local", aaguid: BITWARDEN }, trusted)
    await expect(run).rejects.toMatchObject({
      name: "PhoneRequiredError",
      providerName: "Bitwarden",
      message: new PhoneRequiredError({ providerName: "Bitwarden" }).message,
    })
    expect(ceremony.assertRequests).toHaveLength(0)
  })

  it("points Windows Hello at Windows' own prompt, whichever of its ids answered", async () => {
    for (const aaguid of WINDOWS_HELLO_AAGUIDS) {
      const { run } = create("laptop", { route: "local", aaguid }, trusted)
      await expect(run).rejects.toMatchObject({
        providerName: "Windows Hello",
        message: expect.stringMatching(/^Windows Hello saved this passkey on this computer/),
      })
    }
  })

  it("says this device, not this computer, for a phone's own manager in desktop mode", async () => {
    // A desktop-mode Android phone counts as a laptop, and its local answer is on the phone.
    const { run } = create(
      "laptop",
      { route: "local", manager: "gpm", aaguid: GPM_AAGUID },
      trusted,
    )
    const err = await run.then(
      () => undefined,
      (e: Error) => e,
    )
    expect(err?.message).toMatch(/^Google Password Manager saved this passkey on this device/)
    expect(err?.message).not.toContain("this computer")
  })

  it("names nothing it cannot identify", async () => {
    for (const aaguid of [UNMEASURED, ZERO_AAGUID, undefined]) {
      const { run } = create("laptop", { route: "local", aaguid }, trusted)
      await expect(run).rejects.toMatchObject({ providerName: undefined, message: unnamed })
    }
  })

  it("names nothing unless the browser's label is trusted", async () => {
    for (const extra of [
      {},
      { attachmentLabelTrusted: false },
      { ...trusted, misreportsCrossDevice: true },
    ]) {
      const { run } = create("laptop", { route: "local", aaguid: BITWARDEN }, extra)
      await expect(run).rejects.toMatchObject({ providerName: undefined, message: unnamed })
    }
  })

  it("names nothing when the browser did not say which device answered", async () => {
    const { run } = create(
      "laptop",
      { route: "local", aaguid: BITWARDEN, attachment: null },
      trusted,
    )
    await expect(run).rejects.toMatchObject({
      name: "PhoneRequiredError",
      providerName: undefined,
      message: unnamed,
    })
  })

  it("names nothing for a security key's id labelled as this device", async () => {
    const { run } = create(
      "laptop",
      { route: "local", manager: "security-key", aaguid: YUBIKEY_5_USB_A_AAGUID },
      trusted,
    )
    await expect(run).rejects.toMatchObject({ providerName: undefined, message: unnamed })
  })

  it("names nothing for a phone's answer an untrusted browser labelled as this device", async () => {
    const { run } = create(
      "laptop",
      {
        route: "cross-device",
        manager: "icloud",
        aaguid: APPLE_ICLOUD_AAGUID,
        transports: ["hybrid", "internal"],
        attachment: "platform",
      },
      { attachmentLabelTrusted: false },
    )
    await expect(run).rejects.toMatchObject({ providerName: undefined, message: unnamed })
  })

  it("names nothing for the follow-up prompt, which names the credential and not the device", async () => {
    for (const [manager, aaguid] of [
      ["icloud", APPLE_ICLOUD_AAGUID],
      ["gpm", GPM_AAGUID],
      ["1password", ONEPASSWORD_AAGUID],
    ] as const) {
      const { ceremony, run } = create(
        "laptop",
        {
          route: "cross-device",
          manager,
          aaguid,
          prfAtCreate: false,
          assertAttachment: "platform",
        },
        trusted,
      )
      await expect(run).rejects.toMatchObject({
        name: "PhoneRequiredError",
        providerName: undefined,
        message: unnamed,
      })
      expect(ceremony.assertRequests).toHaveLength(1)
    }
  })
})

describe("the fake's security key", () => {
  it("applies the browser's contextualisation once on either route, and nothing of its own", () => {
    // Asserted against the primitives, not against the fake's own table: every other key test
    // compares the driver's output to `prfFor`, which reads that table, so a wrong model would
    // agree with itself. This is the only statement of how a hardware key derives.
    const secret = new Uint8Array(32).fill(3)
    const salt = new Uint8Array(32).fill(4)
    const once = hmac(nobleSha256, secret, contextualiseLocal(salt))
    for (const route of ["local", "cross-device"] as const) {
      expect(fakePrf(secret, salt, "security-key", route)).toEqual(once)
    }
  })
})

describe("security keys at creation", () => {
  /** A roaming key: another device's answer over physical transports, and no backup by design. */
  const key = (over: FakeCeremonyOptions = {}) => ({
    route: "cross-device" as const,
    manager: "security-key" as const,
    transports: ["usb"],
    backupEligible: false as const,
    ...over,
  })

  it("skips the backup gate, chains for the PRF a key withholds, and binds first", async () => {
    const { ceremony, run } = create("laptop", key({ prfAtCreate: false }))
    const result = await run
    expect(result.securityKey).toBe(true)
    expect(result.slot).toBe("first")
    expect(ceremony.assertRequests).toHaveLength(1)
    expect(bytesToHex(result.prfOutput)).toBe(
      bytesToHex(ceremony.prfFor(result.created.credentialId, "first")),
    )
  })

  it("needs no chained assertion when the key answers at creation", async () => {
    const { ceremony, run } = create("laptop", key({ transports: ["nfc", "usb"] }))
    const result = await run
    expect(result.securityKey).toBe(true)
    expect(result.slot).toBe("first")
    expect(ceremony.assertRequests).toHaveLength(0)
  })

  it("a phone over QR is not a key, so its backup flag still decides", async () => {
    const viaPhone = { route: "cross-device" as const, transports: ["hybrid", "internal"] }
    const ok = await create("laptop", { ...viaPhone, backupEligible: true }).run
    expect(ok.securityKey).toBe(false)
    expect(ok.slot).toBe("first")
    for (const transports of [["hybrid", "internal"], ["usb", "something-new"], undefined]) {
      const { run } = create("laptop", {
        route: "cross-device",
        transports,
        backupEligible: false,
      })
      await expect(run).rejects.toThrow(named("DeviceBoundPasskeyError"))
    }
  })

  it("refuses a key whose flags never became readable", async () => {
    const { run } = create("laptop", key({ backupEligible: "unknown", createAuthData: false }))
    await expect(run).rejects.toThrow(named("DeviceBoundPasskeyError"))
  })

  it("refuses a key that returned no PRF on either ceremony, in words a key holder can use", async () => {
    for (const posture of ["laptop", "phone"] as const) {
      const { run } = create(posture, key({ prfAtCreate: false, prfAtAssert: false }))
      await expect(run).rejects.toThrow(named("SecurityKeyNoPrfError"))
    }
  })

  it("keeps the other key-material refusals as they were", async () => {
    // Only a total absence becomes the key's own refusal. A platform passkey with no output, and
    // an unreadable backup flag, each keep their own.
    const platform = create("phone", { route: "local", prfAtCreate: false, prfAtAssert: false })
    await expect(platform.run).rejects.toThrow(named("NoPrfError"))
    const unreadable = create("laptop", key({ backupEligible: "unknown", createAuthData: false }))
    await expect(unreadable.run).rejects.toThrow(named("DeviceBoundPasskeyError"))
  })

  describe("asking the authenticator to take back the credential a failed creation wrote", () => {
    let signalled: { rpId: string; credentialId: string }[]
    let original: unknown

    beforeEach(() => {
      signalled = []
      original = (globalThis as Record<string, unknown>).PublicKeyCredential
      ;(globalThis as Record<string, unknown>).PublicKeyCredential = {
        signalUnknownCredential: (options: { rpId: string; credentialId: string }) => {
          signalled.push(options)
          return Promise.resolve()
        },
      }
    })

    afterEach(() => {
      ;(globalThis as Record<string, unknown>).PublicKeyCredential = original
    })

    /** One ask, for the id the ceremony actually minted, not merely some string. */
    const askedFor = (ceremony: FakePasskeyCeremony) => [
      { rpId: "localhost", credentialId: [...ceremony.creds.keys()][0]! },
    ]

    it("asks once on every refusal, with exactly the id that creation just wrote", async () => {
      // Deleting is irreversible. Each refusal is named, so a case that starts failing for a new
      // reason cannot pass by accident.
      const refused: [FakeCeremonyOptions, DevicePosture, string][] = [
        [key({ prfAtCreate: false, prfAtAssert: false }), "phone", "SecurityKeyNoPrfError"],
        [{ route: "local", prfAtCreate: false, prfAtAssert: false }, "phone", "NoPrfError"],
        [{ route: "local", secondSlot: false }, "phone", "SingleSaltProviderError"],
        [
          key({ backupEligible: "unknown", createAuthData: false }),
          "laptop",
          "DeviceBoundPasskeyError",
        ],
        [{ route: "local", aaguid: BITWARDEN }, "phone", "UnsupportedProviderError"],
        // An unsupported security key, not just an unsupported manager.
        [key({ aaguid: BITWARDEN }), "phone", "UnsupportedProviderError"],
        [{ route: "cross-device" }, "phone", "LocalPasskeyRequiredError"],
        [
          key({ assertAttachment: "platform", prfAtCreate: false }),
          "phone",
          "SecurityKeyRequiredError",
        ],
        [{ route: "local" }, "laptop", "PhoneRequiredError"],
      ]
      // Built and awaited one at a time: a batch started up front leaves rejections unhandled.
      for (const [fake, posture, name] of refused) {
        signalled = []
        const { ceremony, run } = create(posture, fake)
        await expect(run).rejects.toThrow(named(name))
        expect(signalled, name).toEqual(askedFor(ceremony))
      }
    })

    it("asks when the follow-up prompt fails, and throws that prompt's own error", async () => {
      const thrown = new DOMException("Dismissed", "NotAllowedError")
      const { ceremony, run } = create("laptop", {
        route: "cross-device",
        prfAtCreate: false,
        assertOverride: () => {
          throw thrown
        },
      })
      await expect(run).rejects.toBe(thrown)
      expect(passkeyWritten(thrown)).toBe(true)
      expect(signalled).toEqual(askedFor(ceremony))
    })

    it("asks when the caller's own code fails after the credential was written", async () => {
      const boom = new Error("observer")
      const onCreated = create(
        "laptop",
        { route: "cross-device" },
        {
          observe: ({ phase }) => {
            if (phase === "created") throw boom
          },
        },
      )
      await expect(onCreated.run).rejects.toBe(boom)
      expect(signalled).toEqual(askedFor(onCreated.ceremony))

      signalled = []
      const onChained = create(
        "laptop",
        { route: "cross-device", prfAtCreate: false },
        {
          observe: ({ phase }) => {
            if (phase === "chained") throw boom
          },
        },
      )
      await expect(onChained.run).rejects.toBe(boom)
      expect(signalled).toEqual(askedFor(onChained.ceremony))

      // A challenge that rejects with a bare string: nothing to mark, and still one ask.
      signalled = []
      const ceremony = new FakePasskeyCeremony({ route: "cross-device", prfAtCreate: false })
      await expect(
        runPasskeyCreation(ceremony, {
          posture: "laptop",
          rpId: "localhost",
          rpName: "zk.money",
          userName: "@alice",
          challengeForChained: () => Promise.reject("offline"),
        }),
      ).rejects.toBe("offline")
      expect(signalled).toEqual(askedFor(ceremony))
    })

    it("asks, and returns no keys, when the caller ended a creation the browser still answered", async () => {
      // The fake answers whatever its signal says, as a browser that ignores an abort does.
      const before = new AbortController()
      before.abort()
      const late = create("laptop", { route: "cross-device" }, { signal: before.signal })
      await expect(late.run).rejects.toBe(before.signal.reason)
      expect(signalled).toEqual(askedFor(late.ceremony))

      signalled = []
      const during = new AbortController()
      const observed = create(
        "laptop",
        { route: "cross-device" },
        { signal: during.signal, observe: () => during.abort() },
      )
      await expect(observed.run).rejects.toThrow(named("AbortError"))
      expect(signalled).toEqual(askedFor(observed.ceremony))
    })

    it("asks for nothing when a creation succeeds, never answered, or on a sign-in", async () => {
      await create("phone", key()).run
      await create("phone", { route: "local" }).run
      await create("laptop", key({ prfAtCreate: false })).run
      // The browser gave no credential back, so there is no id to name.
      const unanswered = new FakePasskeyCeremony({ route: "cross-device" })
      unanswered.create = async () => {
        throw new DOMException("Dismissed", "NotAllowedError")
      }
      await expect(
        runPasskeyCreation(unanswered, {
          posture: "laptop",
          rpId: "localhost",
          rpName: "zk.money",
          userName: "@alice",
          challengeForChained: () => CHALLENGE,
        }),
      ).rejects.toThrow(named("NotAllowedError"))
      // And a sign-in that fails its own route check never reaches this code at all.
      const signIn = create("laptop", { route: "cross-device" })
      const made = await signIn.run
      signIn.ceremony.opts.route = "local"
      await expect(
        runPasskeyAssertion(signIn.ceremony, {
          posture: "laptop",
          rpId: "localhost",
          challenge: CHALLENGE,
          credentialIds: [made.created.credentialId],
        }),
      ).rejects.toThrow(named("PhoneRequiredError"))
      expect(signalled).toHaveLength(0)
    })

    it("still refuses when the browser has no way to ask", async () => {
      ;(globalThis as Record<string, unknown>).PublicKeyCredential = {}
      const { run } = create("phone", key({ prfAtCreate: false, prfAtAssert: false }))
      await expect(run).rejects.toThrow(named("SecurityKeyNoPrfError"))
    })

    it("still refuses when the ask is rejected", async () => {
      ;(globalThis as Record<string, unknown>).PublicKeyCredential = {
        signalUnknownCredential: () => Promise.reject(new Error("nope")),
      }
      const { run } = create("phone", key({ prfAtCreate: false, prfAtAssert: false }))
      await expect(run).rejects.toThrow(named("SecurityKeyNoPrfError"))
    })

    it("is made from one place in the package, with one caller", () => {
      const src = join(dirname(fileURLToPath(import.meta.url)), "../src")
      const read = (file: string) => readFileSync(join(src, file), "utf8")
      const files = (readdirSync(src, { recursive: true }) as string[]).filter((file) =>
        file.endsWith(".ts"),
      )
      expect(files.filter((file) => read(file).includes("signalUnknownCredential"))).toEqual([
        join("policy", "drivers.ts"),
      ])
      const drivers = read(join("policy", "drivers.ts"))
      expect(drivers.match(/signalUnknownCredential\(/g)).toHaveLength(1)
      // The definition and its one call, in the creation's catch.
      expect(drivers.match(/forgetCredential\(/g)).toHaveLength(2)
    })
  })

  it("gives a laptop's key five minutes to answer too", async () => {
    const { ceremony, run } = create("laptop", key())
    await run
    expect(ceremony.creates[0]!.timeoutMs).toBe(300_000)
  })

  it("a phone accepts a key, binding first through the chained assertion a key needs", async () => {
    const { ceremony, run } = create("phone", key({ prfAtCreate: false }))
    const result = await run
    expect(result.securityKey).toBe(true)
    expect(result.slot).toBe("first")
    expect(ceremony.assertRequests).toHaveLength(1)
  })

  it("a phone accepts a key that answered completely, with no chained assertion at all", async () => {
    // Firmware that evaluates key material at creation skips the chain: the driver branches on
    // the evidence being complete, never on the class.
    const { ceremony, run } = create("phone", key())
    const result = await run
    expect(result.slot).toBe("first")
    expect(ceremony.assertRequests).toHaveLength(0)
  })

  it("a phone refuses a key whose chained assertion comes back local, naming the key", async () => {
    const { run } = create("phone", key({ prfAtCreate: false, assertAttachment: "platform" }))
    await expect(run).rejects.toThrow(named("SecurityKeyRequiredError"))
  })

  it("refuses a creation whose attachment the browser never reported, on either posture", async () => {
    for (const posture of ["phone", "laptop"] as const) {
      const { run } = create(posture, key({ attachment: null }))
      await expect(run).rejects.toThrow(
        expect.objectContaining({ name: expect.stringMatching(/RequiredError$/) }),
      )
    }
    // And the same on the chained half, where the class is already known to be a key.
    const chained = create("phone", key({ prfAtCreate: false, assertAttachment: null }))
    await expect(chained.run).rejects.toThrow(named("SecurityKeyRequiredError"))
  })

  it("admits a key whose own id surfaced", async () => {
    const result = await create("laptop", key({ aaguid: YUBIKEY_5_USB_A_AAGUID })).run
    expect(result.securityKey).toBe(true)
    expect(result.slot).toBe("first")
  })

  it("refuses a key reporting a manager's id, with the key's own advice", async () => {
    const { run } = create("laptop", key({ aaguid: GPM_AAGUID }))
    await expect(run).rejects.toMatchObject({
      name: "UnsupportedProviderError",
      kind: "security-key",
    })
    await expect(run).rejects.toThrow(/YubiKey 5/)
  })

  it("gives a key whose transports were withheld the key's advice, not a manager's", async () => {
    // Classed as a phone, so the backup gate applied; the orphan is still on the key.
    const { run } = create("laptop", {
      route: "cross-device",
      aaguid: YUBIKEY_5_USB_A_AAGUID,
      backupEligible: true,
    })
    await expect(run).rejects.toMatchObject({
      name: "UnsupportedProviderError",
      kind: "security-key",
    })
    await expect(run).rejects.toThrow(/YubiKey 5/)
  })
})

describe("the written mark", () => {
  const rejection = async (run: Promise<unknown>): Promise<unknown> => {
    try {
      await run
    } catch (err) {
      return err
    }
    throw new Error("expected a rejection")
  }

  it.each<[string, DevicePosture, FakeCeremonyOptions, string]>([
    [
      "another device answering a phone",
      "phone",
      { route: "cross-device" },
      "LocalPasskeyRequiredError",
    ],
    [
      "a laptop's own answer",
      "laptop",
      { route: "local", aaguid: UNMEASURED },
      "PhoneRequiredError",
    ],
    [
      "an unmeasured manager",
      "laptop",
      { route: "cross-device", aaguid: BITWARDEN },
      "UnsupportedProviderError",
    ],
    [
      "a single-salt provider",
      "phone",
      { route: "local", secondSlot: false },
      "SingleSaltProviderError",
    ],
    [
      "no backup flag",
      "laptop",
      { route: "cross-device", backupEligible: false },
      "DeviceBoundPasskeyError",
    ],
    [
      "no PRF on either prompt",
      "laptop",
      { route: "cross-device", prfAtCreate: false, prfAtAssert: false },
      "NoPrfError",
    ],
    [
      "a security key with no PRF",
      "laptop",
      {
        route: "cross-device",
        manager: "security-key",
        transports: ["usb"],
        backupEligible: false,
        prfAtCreate: false,
        prfAtAssert: false,
      },
      "SecurityKeyNoPrfError",
    ],
  ])("marks a refusal for %s: the passkey is already saved", async (_n, posture, fake, name) => {
    const err = await rejection(create(posture, fake).run)
    expect(err).toMatchObject({ name })
    expect(passkeyWritten(err)).toBe(true)
  })

  it.each([
    ["a blocked related-origin request", () => new RelatedOriginPasskeyError()],
    ["the browser's cancel", () => new DOMException("Dismissed", "NotAllowedError")],
    ["an extension's own error", () => new Error("Something went wrong.")],
  ])("marks %s from the follow-up prompt, and keeps the error itself", async (_n, make) => {
    const thrown = make()
    const { ceremony, run } = create("laptop", {
      route: "cross-device",
      prfAtCreate: false,
      assertOverride: () => {
        throw thrown
      },
    })
    const err = await rejection(run)
    expect(err).toBe(thrown)
    expect(passkeyWritten(err)).toBe(true)
    expect(ceremony.assertRequests).toHaveLength(1)
  })

  it("marks a corrected laptop creation that came back incomplete", async () => {
    const { run } = create(
      "laptop",
      {
        route: "cross-device",
        manager: "icloud",
        aaguid: APPLE_ICLOUD_AAGUID,
        transports: ["hybrid", "internal"],
        attachment: "platform",
        prfAtCreate: false,
      },
      { misreportsCrossDevice: true },
    )
    const err = await rejection(run)
    expect(err).toMatchObject({ name: "IncompleteCreationError" })
    expect(passkeyWritten(err)).toBe(true)
  })

  it("marks an observer's own error from the created phase", async () => {
    const boom = new Error("observer")
    const { run } = create(
      "laptop",
      { route: "cross-device" },
      {
        observe: ({ phase }) => {
          if (phase === "created") throw boom
        },
      },
    )
    const err = await rejection(run)
    expect(err).toBe(boom)
    expect(passkeyWritten(err)).toBe(true)
  })

  it("marks nothing the first prompt itself threw", async () => {
    const thrown = new RelatedOriginPasskeyError()
    const ceremony = new FakePasskeyCeremony({ route: "cross-device" })
    ceremony.create = async () => {
      throw thrown
    }
    const err = await rejection(
      runPasskeyCreation(ceremony, {
        posture: "laptop",
        rpId: "localhost",
        rpName: "zk.money",
        userName: "@alice",
        challengeForChained: () => CHALLENGE,
      }),
    )
    expect(err).toBe(thrown)
    expect(passkeyWritten(err)).toBe(false)
  })

  it("marks nothing on the assertion side: the driver's refusal, or the one read from its result", async () => {
    const assertion = async (posture: DevicePosture, fake: FakeCeremonyOptions) => {
      const ceremony = new FakePasskeyCeremony(fake)
      const created = await ceremony.create({
        rpId: "localhost",
        rpName: "zk.money",
        userName: "@alice",
        prfFirstSalt: new Uint8Array(32),
      })
      return runPasskeyAssertion(ceremony, {
        posture,
        rpId: "localhost",
        challenge: CHALLENGE,
        credentialIds: [created.credentialId],
      })
    }
    const local = await rejection(assertion("laptop", { route: "local" }))
    expect(local).toMatchObject({ name: "PhoneRequiredError" })
    expect(passkeyWritten(local)).toBe(false)

    const raw = await assertion("phone", { route: "local", backupEligible: false })
    let bound: unknown
    try {
      candidatesFrom(raw)
    } catch (err) {
      bound = err
    }
    expect(bound).toMatchObject({ name: "DeviceBoundPasskeyError" })
    expect(passkeyWritten(bound)).toBe(false)
  })
})

describe("runPasskeyAssertion", () => {
  async function assertion(posture: DevicePosture, fake: FakeCeremonyOptions) {
    const ceremony = new FakePasskeyCeremony(fake)
    const created = await ceremony.create({
      rpId: "localhost",
      rpName: "zk.money",
      userName: "@alice",
      prfFirstSalt: new Uint8Array(32),
    })
    const phases: string[] = []
    const result = runPasskeyAssertion(ceremony, {
      posture,
      rpId: "localhost",
      challenge: CHALLENGE,
      credentialIds: [created.credentialId],
      observe: (event) => void phases.push(event.phase),
    })
    return { ceremony, created, result, phases }
  }

  it("phone: another device's answer is returned and yields both candidates", async () => {
    const { ceremony, created, result, phases } = await assertion("phone", {
      route: "cross-device",
    })
    const raw = await result
    expect(phases).toEqual(["asserted"])
    const candidates = candidatesFrom(raw)
    expect(bytesToHex(candidates.first!)).toBe(
      bytesToHex(ceremony.prfFor(created.credentialId, "first")),
    )
    expect(bytesToHex(candidates.second!)).toBe(
      bytesToHex(ceremony.prfFor(created.credentialId, "second")),
    )
    expect(ceremony.assertRequests[0]).toMatchObject({
      credentialIds: [created.credentialId],
      challenge: CHALLENGE,
    })
    expect(ceremony.assertRequests[0]!.hints).toBeUndefined()
    expect(ceremony.assertRequests[0]!.prfSecondSalt).toHaveLength(32)
  })

  it("the caller's signal reaches the ceremony", async () => {
    const ceremony = new FakePasskeyCeremony({ route: "cross-device" })
    const created = await ceremony.create({
      rpId: "localhost",
      rpName: "zk.money",
      userName: "@alice",
      prfFirstSalt: new Uint8Array(32),
    })
    const controller = new AbortController()
    await runPasskeyAssertion(ceremony, {
      posture: "phone",
      rpId: "localhost",
      challenge: CHALLENGE,
      credentialIds: [created.credentialId],
      signal: controller.signal,
    })
    expect(ceremony.assertRequests[0]!.signal).toBe(controller.signal)
  })

  it("laptop: the record's transports reach the ceremony, minus the device's own", async () => {
    const ceremony = new FakePasskeyCeremony({ route: "cross-device" })
    const created = await ceremony.create({
      rpId: "localhost",
      rpName: "zk.money",
      userName: "@alice",
      prfFirstSalt: new Uint8Array(32),
    })
    await runPasskeyAssertion(ceremony, {
      posture: "laptop",
      rpId: "localhost",
      challenge: CHALLENGE,
      credentialIds: [created.credentialId],
      transports: ["hybrid", "internal"],
    })
    expect(ceremony.assertRequests[0]!.transports).toEqual(["hybrid"])
  })

  it("laptop: a credential with no recorded transports names the cross-device routes", async () => {
    const { ceremony, result } = await assertion("laptop", { route: "cross-device" })
    await result
    expect(ceremony.assertRequests[0]!.transports).toEqual([
      "hybrid",
      "usb",
      "nfc",
      "ble",
      "smart-card",
    ])
  })

  it("laptop: a local answer is refused, after the observer saw it", async () => {
    const { result, phases } = await assertion("laptop", { route: "local" })
    // A sign-in keeps its own wording: its passkey already lives on a phone or a key.
    await expect(result).rejects.toMatchObject({
      name: "PhoneRequiredError",
      message: new PhoneRequiredError().message,
    })
    expect(phases).toEqual(["asserted"])
  })

  it("laptop: with the local route allowed, its own answer passes; a hybrid-only record sends no transports", async () => {
    const ceremony = new FakePasskeyCeremony({ route: "local" })
    const created = await ceremony.create({
      rpId: "localhost",
      rpName: "zk.money",
      userName: "@alice",
      prfFirstSalt: new Uint8Array(32),
    })
    const raw = await runPasskeyAssertion(ceremony, {
      posture: "laptop",
      rpId: "localhost",
      challenge: CHALLENGE,
      credentialIds: [created.credentialId],
      transports: ["hybrid"],
      localAllowed: true,
    })
    expect(raw.authenticatorAttachment).toBe("platform")
    // The bound slot for a local answer, so the anchors have a candidate to check.
    expect(candidatesFrom(raw).second).toBeDefined()
    // No restriction: a hybrid-only record must not exclude the device's own copy.
    expect(ceremony.assertRequests[0]!.transports).toBeUndefined()
    // No security key named, so a manager's extension may answer for the synced copy.
    expect(ceremony.assertRequests[0]!.hints).toEqual(["client-device"])
  })

  it("laptop: the local route with suppressed hints sends neither hints nor transports and still passes", async () => {
    const ceremony = new FakePasskeyCeremony({ route: "local" })
    const created = await ceremony.create({
      rpId: "localhost",
      rpName: "zk.money",
      userName: "@alice",
      prfFirstSalt: new Uint8Array(32),
    })
    const raw = await runPasskeyAssertion(ceremony, {
      posture: "laptop",
      rpId: "localhost",
      challenge: CHALLENGE,
      credentialIds: [created.credentialId],
      transports: ["hybrid"],
      laptopHints: null,
      localAllowed: true,
    })
    expect(candidatesFrom(raw).second).toBeDefined()
    expect(ceremony.assertRequests[0]!.transports).toBeUndefined()
    expect(ceremony.assertRequests[0]!.hints).toBeUndefined()
  })

  it("waits for the observer before checking the route", async () => {
    const ceremony = new FakePasskeyCeremony({ route: "local" })
    await ceremony.create({
      rpId: "localhost",
      rpName: "zk.money",
      userName: "@alice",
      prfFirstSalt: new Uint8Array(32),
    })
    let release!: () => void
    const gate = new Promise<void>((resolve) => (release = resolve))
    let entered!: () => void
    const observing = new Promise<void>((resolve) => (entered = resolve))
    const result = runPasskeyAssertion(ceremony, {
      posture: "laptop",
      rpId: "localhost",
      challenge: CHALLENGE,
      observe: () => {
        entered()
        return gate
      },
    })
    let settled = false
    result.then(
      () => (settled = true),
      () => (settled = true),
    )
    await observing
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(settled).toBe(false)
    release()
    await expect(result).rejects.toThrow(named("PhoneRequiredError"))
  })

  it("an observer that throws ends the assertion with its own error", async () => {
    const ceremony = new FakePasskeyCeremony({ route: "local" })
    await ceremony.create({
      rpId: "localhost",
      rpName: "zk.money",
      userName: "@alice",
      prfFirstSalt: new Uint8Array(32),
    })
    await expect(
      runPasskeyAssertion(ceremony, {
        posture: "laptop",
        rpId: "localhost",
        challenge: CHALLENGE,
        observe: () => Promise.reject(new Error("observer down")),
      }),
    ).rejects.toThrow(/observer down/)
  })

  it("laptop: a phone's answer is returned raw for the caller's own gates", async () => {
    const { ceremony, result } = await assertion("laptop", {
      route: "cross-device",
      backupEligible: false,
    })
    const raw = await result
    expect(raw.backupEligible).toBe(false)
    // Both routes named, since a laptop sign-in refuses a local answer either way.
    expect(ceremony.assertRequests[0]!.hints).toEqual(["hybrid", "security-key"])
    // Another device answered: a security key, or a phone passkey no anchor will match.
    expect(candidatesFrom(raw).first).toBeDefined()
  })

  it("phone: its own answer that cannot be backed up is still refused", async () => {
    const { result } = await assertion("phone", { route: "local", backupEligible: false })
    const raw = await result
    expect(() => candidatesFrom(raw)).toThrow(named("DeviceBoundPasskeyError"))
  })

  describe("on a browser that mislabels a cross-device answer", () => {
    async function mislabelled(posture: DevicePosture, fake: FakeCeremonyOptions, flag = true) {
      const ceremony = new FakePasskeyCeremony(fake)
      const created = await ceremony.create({
        rpId: "localhost",
        rpName: "zk.money",
        userName: "@alice",
        prfFirstSalt: new Uint8Array(32),
      })
      const seen: ObservedCeremony[] = []
      const result = runPasskeyAssertion(ceremony, {
        posture,
        rpId: "localhost",
        challenge: CHALLENGE,
        credentialIds: [created.credentialId],
        misreportsCrossDevice: flag,
        observe: (event) => void seen.push(event),
      })
      return { ceremony, created, result, seen }
    }

    it("laptop: a phone's answer labelled as the laptop's own is returned as another device's", async () => {
      const { ceremony, created, result, seen } = await mislabelled("laptop", {
        route: "cross-device",
        attachment: "platform",
      })
      const raw = await result
      expect(raw.authenticatorAttachment).toBe("cross-platform")
      expect(seen[0]!.result.authenticatorAttachment).toBe("platform")
      expect(bytesToHex(candidatesFrom(raw).first!)).toBe(
        bytesToHex(ceremony.prfFor(created.credentialId, "first")),
      )
    })

    it("laptop: this device's own answer is admitted too, for the caller's anchors to judge", async () => {
      const { result } = await mislabelled("laptop", { route: "local" })
      const raw = await result
      expect(raw.authenticatorAttachment).toBe("cross-platform")
      expect(candidatesFrom(raw).second).toBeDefined()
      // Even one that cannot be backed up: the corrected label exempts it from the backup gate, as
      // any other device's answer is, and the anchors decide what it opens.
      const bound = await mislabelled("laptop", { route: "local", backupEligible: false })
      expect(candidatesFrom(await bound.result).first).toBeDefined()
    })

    it("laptop: without the flag a local answer is refused as before", async () => {
      const { result } = await mislabelled("laptop", { route: "local" }, false)
      await expect(result).rejects.toThrow(named("PhoneRequiredError"))
    })

    it("phone: nothing changes", async () => {
      const { result } = await mislabelled("phone", { route: "local" })
      expect((await result).authenticatorAttachment).toBe("platform")
    })
  })
})
