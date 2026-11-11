// The sign-in flow over a real session, every outside call a spy the test answers.
import { vi } from "vitest"
import { createPasskeyTelemetry } from "@obsidion/passkey-web"
import {
  openSignInFlow,
  type SignInInputs,
} from "../../src/features/onboarding/EnterAppScreen/signInFlow"
import type { GateResult } from "../../src/features/identity/ceremonyGate"
import type { Session } from "../../src/session/session"
import { defaultConfig, seedDeviceKeys } from "./page"
import { openTestSession } from "./session"

export const flush = () => new Promise((resolve) => setTimeout(resolve, 0))
export const L2 = `0x${"ac".repeat(32)}`
export const OTHER = `0x${"bd".repeat(32)}`
export const ACCOUNT = `0x${"11".repeat(20)}`
export const CREDENTIAL = "cred-alice"
/** @alice's one installed key, as the L1 read lists it. */
export const KEYS = [
  {
    pubkeyHex: "ab".repeat(64),
    metadata: `0x${"07".repeat(16)}`,
    parsed: { kind: "credential-id" as const, credentialId: CREDENTIAL },
  },
]
/** What Login pins: the tag's account and its keys. */
export const FOUND = { account: ACCOUNT, l2Address: L2, keys: KEYS }
export const resolved = (tag = "alice", keys: unknown[] = KEYS, moreKeys = false) => ({
  kind: "resolved",
  tag,
  account: ACCOUNT,
  l2Address: L2,
  keys,
  moreKeys,
})
export const named = (handle = "alice", held = () => true) => ({
  entered: true,
  handle,
  address: L2,
  account: {},
  held,
})
export const ceremonyRequired = { entered: false, reason: "ceremony-required" }
export const confirmResult = () => ({
  entered: false,
  reason: "confirm",
  claim: {},
  account: { getAddress: () => ({ toString: () => L2 }) },
  held: () => true,
})
export const unknownResult = (extra: object = {}) => ({
  entered: false,
  reason: "unknown",
  credentialId: CREDENTIAL,
  addresses: [OTHER],
  ...extra,
})
/** A recovered account with no registered name, committed under `session`. */
export const nameless = (session: Session, extra: object = {}) => ({
  entered: false,
  reason: "unclaimed",
  account: { getAddress: () => ({ toString: () => L2 }) },
  held: () => true,
  session,
  bootstrap: { address: "0xE0A0000000000000000000000000000000000001" },
  ensDomain: "zk.money",
  ...extra,
})

/** This browser's root records, each with the tag it claimed. */
export function remember(
  ...rows: { credentialId: string; usertag?: string; createdAt?: number; l2Address?: string }[]
) {
  const entries = Object.fromEntries(
    rows.map((row) => [
      row.credentialId,
      {
        rpId: "localhost",
        l2Address: L2,
        pubkey: `0x${"AB".repeat(64)}`,
        isMskRoot: true,
        createdAt: 1,
        ...row,
      },
    ]),
  )
  return seedDeviceKeys({ passkeyMap: JSON.stringify({ version: 1, entries }) })
}

const LAPTOP: GateResult = {
  choice: "computer",
  route: "this-device",
  reach: "ok",
  creation: { local: false, chromeTip: false },
  signal: new AbortController().signal,
}

/**
 * The flow as `/enter?<search>` opens it, over a ready wallet unless `wallet` is given, against a
 * live account service.
 */
export async function openSignIn(
  search = "",
  options: {
    start?: boolean
    next?: string
    wallet?: unknown
    accountServiceTestMode?: boolean
  } = {},
) {
  const session = openTestSession({
    config: { ...defaultConfig, accountServiceTestMode: options.accountServiceTestMode ?? false },
    wallet: options.wallet ?? { networkId: "0xnet" },
    contractService: {},
    auth: { recoverFromCache: vi.fn(async () => undefined), recordsStale: () => false },
  })
  await session.registrations.ready
  const io = {
    telemetry: () => createPasskeyTelemetry({ send: () => {} }),
    fire: vi.fn(),
    fireOnboarding: vi.fn(),
    landing: vi.fn(),
    report: vi.fn(),
    enterWithPasskey: vi.fn(async (): Promise<unknown> => ceremonyRequired),
    lookup: vi.fn(async (): Promise<unknown> => ({ kind: "notFound" })),
    probeName: vi.fn(async () => ({ status: "unknown" })),
    diagnoseMiss: vi.fn(),
    reservedNameHashes: vi.fn(async (): Promise<string[]> => []),
    boundNameGrantOwner: vi.fn(async () => false),
    claimTag: vi.fn<(...args: unknown[]) => Promise<unknown>>(async () => ({
      kind: "pending",
      oxideAccount: ACCOUNT,
    })),
    collectKeys: vi.fn(async () => ({})),
    confirmTag: vi.fn(),
    warm: vi.fn(async () => ({})),
    retired: vi.fn(async (): Promise<unknown[]> => []),
    leave: vi.fn(async () => {}),
  }
  const gate = { gate: vi.fn(async () => LAPTOP), cancel: vi.fn() }
  const navigate = vi.fn()
  const inputs: SignInInputs = {
    navigate,
    params: new URLSearchParams(search),
    nextRoute: options.next,
    gate,
  }
  const flow = openSignInFlow(
    { session, origin: "http://localhost:3000", io: io as never },
    () => inputs,
  )
  const ended = new AbortController()
  const start = async () => {
    flow.start(ended.signal)
    await flush()
  }
  if (options.start !== false) await start()
  /** The last sign-in's options, and its tag. */
  const lastEntry = (): Record<string, unknown> => {
    const call = io.enterWithPasskey.mock.calls.at(-1) as unknown[] | undefined
    return { tag: call?.[2], ...(call?.[3] as object) }
  }
  /** Every failed entry counted, as (action, code). */
  const failures = () =>
    io.fire.mock.calls
      .filter(([name]) => name === "action_failed")
      .map(([, props]) => [(props as { action: string }).action, (props as { code: string }).code])
  const entered = () => navigate.mock.calls.some(([to]) => to === "/")
  return { flow, io, session, gate, navigate, ended, start, lastEntry, failures, entered }
}

/** Types `tag` and leaves the field, so it is read at once. */
export async function typeTag(flow: ReturnType<typeof openSignInFlow>, tag: string) {
  flow.tagChanged(tag)
  flow.tagBlurred()
  await flush()
}
