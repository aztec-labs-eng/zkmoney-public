import React, { act, type ReactNode } from "react"
import { createRoot } from "react-dom/client"
import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import ts from "typescript"
import { expect, it } from "vitest"
import { SavingsProvider, useSavingsPosition } from "@obsidion/front-core"
import { memoryStore } from "@obsidion/front-core/dist/engine/store.js"

it("makes the loaded Savings position available to the upgrade dialog", async () => {
  const balance = { scope: "upgrade-provider", tokenAddress: "0xsavings" }
  const balances = memoryStore({
    hydrated: true,
    entries: [{ scope: balance.scope, token: balance.tokenAddress, atomic: 0n }],
  }).readonly
  const source = {
    balance,
    readPrice: async () => ({ sharePrice: 10n ** 18n, readAt: 1 }),
  }
  const Wrapper = ({ children }: { children?: ReactNode }) => children
  const Empty = () => null
  const Savings = ({ children }: { children?: ReactNode }) => (
    <SavingsProvider source={source as never} balances={balances}>
      {children}
    </SavingsProvider>
  )
  function Upgrade() {
    const { position } = useSavingsPosition()
    return <button disabled={position === null}>Upgrade now</button>
  }
  // Render WalletGate's actual unlocked composition. Keep the Savings context real.
  const app = ts.createSourceFile(
    "App.tsx",
    readFileSync(resolve(__dirname, "../src/App.tsx"), "utf8"),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  )
  const gate = app.statements.find(
    (node): node is ts.FunctionDeclaration =>
      ts.isFunctionDeclaration(node) && node.name?.text === "WalletGate",
  )!
  const returned = gate.body!.statements.filter(ts.isReturnStatement).at(-1)!
  const { outputText } = ts.transpileModule(`function Gate() { ${returned.getText(app)} }`, {
    compilerOptions: { jsx: ts.JsxEmit.React, target: ts.ScriptTarget.ES2022 },
  })
  const bindings = {
    React,
    UnlockGate: Wrapper,
    isDemoMode: () => true,
    XmtpMount: Empty,
    NotificationsMount: Empty,
    ReorgMonitorMount: Empty,
    SponsoredRailReadinessMount: Empty,
    PaylinkClaimMount: Empty,
    TransferScannerMount: Empty,
    SipaDepositsMount: Empty,
    WebSavingsProvider: Savings,
    Outlet: Empty,
    MigrationDetectionMount: Upgrade,
    CutoverLogoutMount: Empty,
  }
  const Gate = new Function(...Object.keys(bindings), `${outputText}; return Gate`)(
    ...Object.values(bindings),
  )
  const host = document.createElement("div")
  const root = createRoot(host)
  try {
    await act(async () => root.render(<Gate />))
    expect(host.querySelector("button")!.disabled).toBe(false)
  } finally {
    await act(async () => root.unmount())
  }
})
