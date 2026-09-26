// Browser-test harness; this module is never imported by the application.
import { useState } from "react"
import { createRoot } from "react-dom/client"
import { ContactStorage } from "@obsidion/front-core"
import { Modal } from "../../../src/ui/Modal"

function Probe() {
  const [open, setOpen] = useState(false)
  const [nested, setNested] = useState(false)
  const [busy, setBusy] = useState(false)
  const [destination, setDestination] = useState(false)
  return <>
    <button onClick={() => setOpen(true)}>Open probe</button>
    <button>Background probe</button>
    {destination && <input aria-label="Destination probe" autoFocus />}
    {open && <Modal title="Outer probe" onClose={busy ? undefined : () => setOpen(false)}>
      <button onClick={() => setNested(true)}>Open nested probe</button>
      <button onClick={() => { setOpen(false); setDestination(true) }}>Open destination probe</button>
      <button onClick={() => setBusy(!busy)}>{busy ? "Finish probe" : "Hold probe"}</button>
      {nested && <Modal title="Inner probe" onClose={() => setNested(false)}><button>Inner action</button></Modal>}
    </Modal>}
  </>
}
export function mountDialogProbe() {
  const host = document.createElement("div")
  document.body.append(host)
  createRoot(host).render(<Probe />)
}

/** Preserve real stored history while removing the payable tag for the footerless case. */
export async function seedAddressOnlyConversation() {
  const contacts = ContactStorage.get()
  const ada = (await contacts.getEntries()).find((entry) => entry.tag === "ada")!
  await contacts.modifyEntry({ ...ada, tag: undefined }, { address: ada.address })
  window.scrollTo(0, 0)
  window.history.pushState({}, "", `/contacts/${ada.address}`)
  window.dispatchEvent(new PopStateEvent("popstate"))
}
