// @vitest-environment node
/** Each backup passkey capture opens its plan's screen, and every screen has a plan. */
import { describe, expect, it } from "vitest"
import {
  selectBackupScreen,
  type BackupScreenId,
  type BackupScreenInput,
  type KeysRead,
} from "../../src/features/backupPasskey/backupScreen"
import {
  BACKUP_FIXTURES,
  CAPTURE_NOW,
  keyPubkey,
  type FixtureKeys,
} from "../../scripts/ui-capture/fixtures/backup-passkey"

const SESSION = "5e".repeat(64)
const SCREENS: Record<BackupScreenId, true> = {
  loading: true,
  keys: true,
  intro: true,
  place: true,
  blocked: true,
  unavailable: true,
  unreadable: true,
  firstPasskey: true,
  approve: true,
  adding: true,
  finish: true,
  done: true,
  failed: true,
  recovery: true,
}
const plans = import.meta.glob<{ path: string; steps: { path?: string }[] }>(
  "../../scripts/ui-capture/plans/backup-passkey/*.json",
  { eager: true, import: "default" },
)

/** The key list as the sheet reads it from the fixture's keys. */
function keysRead(keys: FixtureKeys): KeysRead {
  if (keys === "loading") return undefined
  if (typeof keys === "string") return keys
  return {
    keys: keys.map((key) => ({
      pubkeyHex: keyPubkey(key, SESSION),
      role: key.role,
      signsHere: key.session,
      ...(key.name && { name: key.name }),
    })),
    count: keys.length,
  }
}

/** What the host passes in a capture: no saved record, its deps building, no new add allowed. */
const HOST: Omit<BackupScreenInput, "keys"> = {
  saved: null,
  deps: "building",
  addable: false,
  laptop: false,
  oneDevice: false,
  busy: false,
  cancelled: false,
  now: CAPTURE_NOW,
}

const fixtureOf = (path: string) =>
  new URL(path, "http://capture").searchParams.get("backupFixture")

describe("backup passkey captures", () => {
  it.each(Object.entries(BACKUP_FIXTURES))("%s opens its screen", (_, fixture) => {
    const input = { ...HOST, keys: keysRead(fixture.keys), ...fixture.input }
    expect(selectBackupScreen(input).id).toBe(fixture.screen)
  })

  it.each([
    "finish-links",
    "finish-main-confirming",
    "finish-savings-asking",
    "finish-upper-bound",
    "finish-rows-declined",
  ] as const)("%s shows the move as rows", (name) => {
    const fixture = BACKUP_FIXTURES[name]
    const screen = selectBackupScreen({ ...HOST, keys: keysRead(fixture.keys), ...fixture.input })
    expect(screen.id === "finish" && screen.progress.rows?.length).toBeGreaterThan(0)
  })

  it("has one plan per screen, opening every fixture of that screen", () => {
    const planned = Object.fromEntries(
      Object.entries(plans).map(([file, plan]) => [
        file.replace(/^.*\/(\w+)\.json$/, "$1"),
        [plan.path, ...plan.steps.flatMap((step) => step.path ?? [])].map(fixtureOf).sort(),
      ]),
    )
    const expected = Object.fromEntries(
      Object.keys(SCREENS).map((screen) => [
        screen,
        Object.entries(BACKUP_FIXTURES)
          .filter(([, fixture]) => fixture.screen === screen)
          .map(([name]) => name)
          .sort(),
      ]),
    )
    expect(planned).toEqual(expected)
  })
})
