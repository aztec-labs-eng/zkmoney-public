import { afterEach, describe, expect, it } from "vitest"
import { testPage, testCore } from "../support/page"
import { sessionPage } from "../support/session"
import { createAccountRecord, createOperations } from "@obsidion/front-core"
import type { ObsidionAccount } from "@obsidion/sdk"
import { pageSessionDeps } from "../../src/app/sessionDeps"
import {
  activeNamespace,
  closeSession,
  commitSecret,
  handOffAccount,
  namespaceOf,
  openedSession,
  signedInAccount,
  switchSession,
} from "../../src/session/session"
import type { CommitSecretInput } from "@obsidion/sdk"
import { writeDeviceKeys } from "../../src/platform/storage/deviceKeys"
import { runOperation } from "../../src/features/operations/operations"

const deviceDb = testPage().database

const account = (address: string) => ({
  type: "saved" as const,
  completeAddress: address,
  signer: { credentialId: address, pubkey: "p" },
})

afterEach(closeSession)

describe("signedInAccount", () => {
  it("saves a sign-in that committed another account to that account, not the open one", async () => {
    await writeDeviceKeys(deviceDb, { storageId: "account-a" })
    const open = switchSession(activeNamespace(testCore().device), pageSessionDeps(testPage()))
    await open.accountRecord!.apply(account("0xa"))
    // B commits; the page serves A until it switches.
    await writeDeviceKeys(deviceDb, { storageId: "account-b" })
    await signedInAccount(open).apply(account("0xb"))

    expect(await open.accountRecord!.get()).toMatchObject({ completeAddress: "0xa" })
    const b = createAccountRecord({
      db: deviceDb.scoped(namespaceOf("account-b").prefix),
      now: () => Date.now(),
    })
    expect(await b.get()).toMatchObject({ completeAddress: "0xb" })
  })
})

describe("commitSecret", () => {
  /** An auth whose commit moves the pointers to `storageId`; nothing follows them. */
  const committingAuth = (storageId: string, generation: number | false = 1) =>
    ({
      commitSecret: async () => {
        if (generation !== false) await writeDeviceKeys(deviceDb, { storageId })
        return generation
      },
    } as never)

  it("hands the flow the committed account's session, not the one it started in", async () => {
    const page = sessionPage(committingAuth("account-a"))
    const visitor = switchSession(activeNamespace(page.device), pageSessionDeps(page))
    expect(visitor.namespace.id).toBeNull()
    const committed = await commitSecret(visitor, {} as CommitSecretInput, () => true)

    expect(committed).not.toBe(false)
    const { generation, session } = committed as Exclude<typeof committed, false>
    expect(generation).toBe(1)
    expect(session.namespace.id).toBe("account-a")
    expect(openedSession.get()).toBe(session)
  })

  it("hands back nothing, and keeps the session, when the commit lands nothing", async () => {
    const page = sessionPage(committingAuth("account-a", false))
    const visitor = switchSession(activeNamespace(page.device), pageSessionDeps(page))
    expect(await commitSecret(visitor, {} as CommitSecretInput, () => true)).toBe(false)
    expect(openedSession.get()).toBe(visitor)
  })
})

describe("handOffAccount", () => {
  it("hands a visitor's flow the account's session, where its operation and record land", async () => {
    const visitor = switchSession(
      activeNamespace(testCore().device),
      pageSessionDeps(sessionPage()),
    )
    expect(visitor.namespace.id).toBeNull()
    await writeDeviceKeys(deviceDb, { storageId: "account-a" })
    const session = handOffAccount(visitor, {} as ObsidionAccount)

    expect(session.namespace.id).toBe("account-a")
    await signedInAccount(session).apply(account("0xa"))
    await runOperation(session, { operationId: "op-1", flow: "send", summary: "$1" }, () =>
      Promise.resolve(),
    )
    expect((await session.operations.get("op-1"))?.state).toBe("settled")
    expect(await session.accountRecord!.get()).toMatchObject({ completeAddress: "0xa" })
    const visitorOps = createOperations({
      db: deviceDb.scoped(namespaceOf(null).prefix),
      now: () => Date.now(),
    })
    expect(await visitorOps.get("op-1")).toBeUndefined()
  })

  it.each([
    ["keeps the open session over a record that loaded", undefined, false],
    ["opens a new session over a record that failed to open, which reads the save", "x", true],
  ])("%s", async (_, blob, replaced) => {
    await writeDeviceKeys(deviceDb, { storageId: "account-a" })
    const db = deviceDb.scoped(namespaceOf("account-a").prefix)
    if (blob) await db.write(async (w) => w.put("obsidion_accounts", blob))
    const open = switchSession(activeNamespace(testCore().device), pageSessionDeps(sessionPage()))
    await Promise.allSettled([open.accountRecord!.get()])
    await open.accountRecord!.apply(account("0xa"))
    const session = handOffAccount(open, {} as ObsidionAccount)

    expect(session !== open).toBe(replaced)
    expect(openedSession.get()).toBe(session)
    expect(await session.accountRecord!.get()).toMatchObject({ completeAddress: "0xa" })
  })
})
