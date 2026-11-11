import { useSyncExternalStore } from "react"
import * as actual from "../../../src/session/useL1Wallet"
import { useSession } from "../../../src/session/session"
import { fixtureState } from "./control"
// The stand-in picker: up from the connect click until the page's fake wallet lands.
let picking = false
const listeners = new Set<() => void>()
const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener) } }
const setPicking = (value: boolean) => { picking = value; listeners.forEach((listener) => listener()) }
/** The real hook over the demo page's fake wallet, with RainbowKit's picker stood in for. */
export const useL1Wallet: typeof actual.useL1Wallet = (opts) => {
  const real = actual.useL1Wallet(opts)
  const { page } = useSession()
  const pickerOpen = useSyncExternalStore(subscribe, () => picking)
  if (!fixtureState()) return real
  const connectAnother: typeof real.connectAnother = (then) => {
    setPicking(true)
    void page.l1Wallet.connectAnother(() => {}, () => picking).then((wallet) => {
      setPicking(false)
      if (wallet) then?.(wallet)
    })
  }
  const connect = async () => connectAnother()
  return {
    ...real,
    pickerOpen,
    connect,
    connectAnother,
    openPicker: connect,
    pickerShown: () => picking,
  }
}
