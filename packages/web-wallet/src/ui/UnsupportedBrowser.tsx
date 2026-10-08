import { useState } from "react"
import { takeHandoffFragment } from "../bridge/fragment"

export function UnsupportedBrowser({ missing }: { missing: string[] }) {
  useState(takeHandoffFragment)
  return (
    <div role="alert" style={{ padding: 24 }}>
      <h1>Browser not supported</h1>
      <p>This browser is too old for zk.money. Update it, or update iOS to 17.4 or later.</p>
      <p>Missing: {missing.join(", ")}</p>
    </div>
  )
}
