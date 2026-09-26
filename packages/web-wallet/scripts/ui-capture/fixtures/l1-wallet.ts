import { useSyncExternalStore } from "react"
import * as actual from "../../../src/features/deposit/l1Wallet"
import { DEMO_L1_ACCOUNT } from "../../../src/dev/fakeL1Rpc"
import { fixtureState, pause } from "./control"
export * from "../../../src/features/deposit/l1Wallet"
let connected = false
// The stand-in picker: up from the connect click until the fake wallet lands.
let picking = false
const listeners = new Set<() => void>()
const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener) } }
const notify = () => listeners.forEach((listener) => listener())
const setConnected = (value: boolean) => { connected = value; picking = false; notify() }
export const useL1Wallet: typeof actual.useL1Wallet = (opts) => {
  const real = actual.useL1Wallet(opts)
  const active = useSyncExternalStore(subscribe, () => connected)
  const pickerOpen = useSyncExternalStore(subscribe, () => picking)
  if (!fixtureState()) return real
  return {
    account: active ? DEMO_L1_ACCOUNT : null,
    accounts: active ? [DEMO_L1_ACCOUNT] : [],
    chainId: active ? opts?.expectedChainId ?? 31337 : null,
    walletName: active ? "Capture wallet" : null,
    connecting: false, wrongChain: false, pickerOpen,
    connect: async () => { picking = true; notify(); await pause(300); setConnected(true) },
    disconnect: () => setConnected(false),
    switchNetwork: async () => {}, selectAccount: () => {}, switchAccount: async () => {},
  }
}
