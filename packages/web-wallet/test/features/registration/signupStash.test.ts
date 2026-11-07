import { afterEach, describe, expect, it } from "vitest"
import { createSignupStash } from "../../../src/features/registration/signupStash"
import { tabStash } from "../../../src/platform/storage/tabStash"

const refusing = {
  get: () => null,
  set: () => {
    throw new Error("blocked")
  },
  remove: () => {
    throw new Error("blocked")
  },
}

describe("the signup stash", () => {
  afterEach(() => {
    sessionStorage.clear()
    window.history.replaceState(null, "", "/")
  })

  it("scopes an inbound grant to its claim route and takes it out of the URL", () => {
    window.history.replaceState(null, "", "/claim/Taga?grant=grant-token")
    createSignupStash(tabStash).stashInbound()
    expect(window.location.search).toBe("")
    const reloaded = createSignupStash(tabStash)
    expect(reloaded.grantToken("taga")).toBe("grant-token")
    expect(reloaded.grantToken("tagb")).toBeUndefined()
  })

  it("drops a grant no claim route scoped", () => {
    sessionStorage.setItem("obsidion.name-grant", "used-token")
    const stash = createSignupStash(tabStash)
    expect(stash.grantToken("new-user")).toBeUndefined()
    expect(sessionStorage.getItem("obsidion.name-grant")).toBeNull()
    window.history.replaceState(null, "", "/claim?grant=used-token")
    stash.stashInbound()
    expect(stash.grantToken("new-user")).toBeUndefined()
  })

  it("gives a grant only to its own claim page and bound sign-in", () => {
    window.history.replaceState(null, "", "/claim/Taga?grant=grant-token")
    const stash = createSignupStash(tabStash)
    stash.stashInbound()
    const page = (path: string) => stash.pageGrantToken(new URL(path, window.location.origin))
    expect(page("/claim/Taga")).toBe("grant-token")
    expect(page("/enter?handle=taga&bound=1")).toBe("grant-token")
    expect(page("/claim/tagb")).toBeUndefined()
    expect(page("/enter?handle=taga")).toBeUndefined()
    expect(page("/enter")).toBeUndefined()
  })

  it("resumes the drawn tag and the settled one after a reload", () => {
    const stash = createSignupStash(tabStash)
    stash.setDrawnOffer("drawn")
    stash.setChosenTag({ tag: "mine", route: "paid" })
    stash.setTagDraft("min")
    expect(createSignupStash(tabStash).state.get()).toEqual({
      grant: undefined,
      drawnOffer: "drawn",
      chosenTag: { tag: "mine", route: "paid" },
      tagDraft: "min",
    })
  })

  it("keeps the page's values where the tab's storage refuses them", () => {
    const stash = createSignupStash(refusing)
    stash.stashDrawnGrant("drawn", "token")
    stash.setDrawnOffer("drawn")
    expect(stash.grantToken("drawn")).toBe("token")
    expect(stash.state.get().drawnOffer).toBe("drawn")
  })
})
