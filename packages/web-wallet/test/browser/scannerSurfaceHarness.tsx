import { useState } from "react"
import { createRoot } from "react-dom/client"
import "../../../design-system/fonts/fonts.css"
import "../../../design-system/src/styles/styles.css"
import "../../../design-system/src/styles/cards-modals.css"
import "../../src/ui/shell.css"
import { ScannerModal } from "../../src/features/scan/ScannerModal"
import type { ScanResult } from "../../src/features/scan/scanPayload"

const events: Array<{ type: string; text?: string }> = []

/** The isolated parent only records handoffs. Production payload classification has its own tests. */
async function resolveFixturePayload(text: string): Promise<ScanResult> {
  events.push({ type: "resolve", text })
  if (text === "invalid") return { kind: "error", message: "This connect code is invalid. Try another code." }
  return { kind: "destination", destination: { to: "/contacts", state: { searchTag: "alice" } } }
}

function Harness() {
  const [view, setView] = useState<"closed" | "scan" | "share" | "destination">("closed")
  return (
    <div className="ww-shell">
      <main style={{ padding: 24, color: "white" }}>
        <p>Isolated scanner harness</p>
        <button type="button" onClick={() => setView("scan")}>Open isolated scanner</button>
        {view === "destination" && <p role="status">Isolated destination received</p>}
        {view === "share" && <button type="button" onClick={() => setView("scan")}>Return to isolated scanner</button>}
      </main>
      {view === "scan" && <ScannerModal
        onClose={() => { events.push({ type: "close" }); setView("closed") }}
        onShare={() => { events.push({ type: "share" }); setView("share") }}
        resolvePayload={resolveFixturePayload}
        onDestination={() => { events.push({ type: "destination" }); setView("destination") }}
      />}
    </div>
  )
}

Object.assign(window, { __scannerSurfaceEvents: events })
createRoot(document.getElementById("root")!).render(<Harness />)
