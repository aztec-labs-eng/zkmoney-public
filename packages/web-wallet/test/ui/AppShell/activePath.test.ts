// @vitest-environment node
/** The nav item lit for a route: a contact is reached through Send, a request through Requests. */
import { describe, expect, it } from "vitest"
import { activePath } from "../../../src/ui/AppShell/activePath"

describe("activePath", () => {
  it.each([
    ["/send", "/send"],
    ["/contacts", "/send"],
    ["/contacts/ada", "/send"],
    ["/contacts/ada/send", "/send"],
    ["/connect", "/send"],
    ["/requests", "/requests"],
    ["/requests/non-contacts", "/requests"],
    ["/receive", "/requests"],
  ])("%s lights the %s item", (pathname, item) => {
    expect(activePath(pathname)).toBe(item)
  })
})
