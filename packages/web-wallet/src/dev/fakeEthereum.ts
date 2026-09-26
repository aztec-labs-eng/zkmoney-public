/**
 * A `window.ethereum` that approves everything instantly. Installing it is also what routes the
 * recovery flow through `injectedWalletChannel` — `isDesktopL1SubmitActive()` goes false the
 * moment an injected provider exists — so the demo exercises the same path a browser user takes.
 */
import { createL1RpcHandler, DEMO_L1_ACCOUNT, type RpcHandler } from "./fakeL1Rpc"

export interface FakeEthereumProvider {
  /** Marks the provider as ours, so a reload can tell it from a real extension. */
  isDemo: true
  request: (args: { method: string; params?: readonly unknown[] }) => Promise<unknown>
  on: () => void
  removeListener: () => void
}

export function createFakeEthereum(handle: RpcHandler): FakeEthereumProvider {
  return {
    isDemo: true,
    request: ({ method, params }) => handle(method, params),
    on: () => {},
    removeListener: () => {},
  }
}

/** Returns the handler so the app's own HTTP L1 client can share it. */
export function installFakeEthereum(chainId: number): RpcHandler {
  const handle = createL1RpcHandler(chainId)
  Object.defineProperty(window, "ethereum", {
    value: createFakeEthereum(handle),
    configurable: true,
    writable: true,
  })
  console.info(`[demo] injected wallet ${DEMO_L1_ACCOUNT} on chain ${chainId}`)
  return handle
}
