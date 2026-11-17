/**
 * The pre-boot layer on a first visit, before boot opens a session. A full payment link sends the
 * visitor to the landing to sign up and keeps the link for the account; a short link waits for the
 * wallet, which looks it up.
 */
import { encodeLinkFragment, LinkKind } from "@obsidion/sdk"
import { act, StrictMode } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, expect, it } from "vitest"
import { peekClaimStash } from "../../src/features/paylink/claimStash"
import { originWasFresh } from "../../src/platform/storage/freshOrigin"
import { tabStash } from "../../src/platform/storage/tabStash"
import { PreBootLayer } from "../../src/ui/PreBootLayer"
import { testPage } from "../support/page"

/**
 * A link made before short links, the whole link in its fragment: `encodePaylinkInline` of secret 7,
 * class 2 and fallback key hash 3. Written out because the codec's encode needs one realm, which
 * jsdom splits.
 */
const FULL =
  "2QEDpwECAgAEWCAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAgUZemkHWCAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAwgabJRnzgNYIAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAH"
const SHORT = encodeLinkFragment(
  LinkKind.Paylink,
  Uint8Array.from({ length: 16 }, (_, i) => i),
)

let root: Root

beforeEach(async () => {
  // jsdom has no OPFS, so the origin holds no wallet database.
  expect(await originWasFresh()).toBe(true)
  const host = document.createElement("div")
  host.id = "pre-boot"
  document.body.append(host)
  root = createRoot(document.body.appendChild(document.createElement("div")))
})

afterEach(async () => {
  await act(async () => root.unmount())
  document.body.replaceChildren()
  sessionStorage.clear()
  history.replaceState(null, "", "/")
})

it.each([
  { link: "a full link", fragment: FULL, opens: "/", stashed: FULL },
  { link: "a short link", fragment: SHORT, opens: `/link#${SHORT}`, stashed: null },
])("$link opens the wallet on $opens", async ({ fragment, opens, stashed }) => {
  history.replaceState(null, "", `/link#${fragment}`)
  const page = testPage()
  await act(async () => {
    root.render(
      <StrictMode>
        <PreBootLayer preBoot={page.preBoot} page={page} landingRate={page.landingRate} />
      </StrictMode>,
    )
  })
  page.preBoot.applyNavigation()
  expect(location.pathname + location.hash).toBe(opens)
  expect(peekClaimStash(tabStash)).toBe(stashed)
})
