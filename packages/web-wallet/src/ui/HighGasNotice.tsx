import { useEffect, useState } from "react"
import { Network } from "@obsidion/core/constants"
import { formatGwei, parseGwei } from "viem"
import { getConfig } from "../config/env"
import { l1PublicClient } from "../config/oxideTuple"
import { pauseWhenHidden } from "../platform/visibilityScheduler"
import { Warning } from "./Warning"

const HIGH_GAS = parseGwei("1")
const POLL_MS = 60_000

/** Warns while L1 gas is high, since deposits, withdrawals and L2 fees all pay for it. */
export function HighGasNotice() {
  const [gasPrice, setGasPrice] = useState<bigint | null>(null)
  useEffect(() => {
    const config = getConfig()
    // The sandbox L1's price says nothing about real fees.
    if (config.network === Network.SANDBOX) return
    const client = l1PublicClient(config)
    // Only the latest read may land, so a slow reply never overwrites a newer one.
    let seq = 0
    const poll = () => {
      const n = ++seq
      client.getGasPrice().then(
        (price) => n === seq && setGasPrice(price),
        () => n === seq && setGasPrice(null),
      )
    }
    poll()
    const timer = pauseWhenHidden.setInterval(poll, POLL_MS)
    return () => {
      seq++
      pauseWhenHidden.clearInterval(timer)
    }
  }, [])

  if (gasPrice === null || gasPrice <= HIGH_GAS) return null
  return (
    <Warning
      title={`Ethereum gas is high (${Number(formatGwei(gasPrice)).toFixed(1)} gwei)`}
      style={{ marginTop: -16, marginBottom: 24 }}
    >
      Deposits and withdrawals may take longer than usual, and fees may be higher.
    </Warning>
  )
}
