import { describe, expect, it } from "vitest"
import { pageSessionDeps } from "../../src/app/sessionDeps"
import { namespaceOf, openSession } from "../../src/session/session"
import { testPage } from "../support/page"

describe("a page's sessions", () => {
  it("share the page's one copy of each page-wide object", () => {
    const deps = pageSessionDeps(testPage())
    const visitor = openSession(deps(namespaceOf(null)))
    const account = openSession(deps(namespaceOf("account-a")))
    expect(account.page.prover).toBe(visitor.page.prover)
    expect(account.page.walletPrompt).toBe(visitor.page.walletPrompt)
    expect(account.page.registrationTurn).toBe(visitor.page.registrationTurn)
    expect(account.page.sponsors).toBe(visitor.page.sponsors)
    expect(account.page.preBoot).toBe(visitor.page.preBoot)
    expect(account.page.preparedTicket).toBe(visitor.page.preparedTicket)
    visitor.close()
    account.close()
  })
})
