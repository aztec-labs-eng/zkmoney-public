import { StrictMode, useState } from "react"
import { createRoot } from "react-dom/client"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { WagmiProvider, http } from "wagmi"
import { mainnet } from "wagmi/chains"
import { getDefaultConfig, RainbowKitProvider, useConnectModal } from "@rainbow-me/rainbowkit"
import { metaMaskWallet } from "@rainbow-me/rainbowkit/wallets"
import "@rainbow-me/rainbowkit/styles.css"
import "../../../design-system/src/styles/styles.css"
import "../../src/ui/shell.css"
import { Modal } from "../../src/ui/Modal"
import { RainbowKitModalLayer } from "../../src/features/deposit/RainbowKitModalLayer"

const config = getDefaultConfig({
  appName: "Modal regression", projectId: "modal-regression",
  wallets: [{ groupName: "Wallets", wallets: [metaMaskWallet] }],
  chains: [mainnet], transports: { [mainnet.id]: http("http://127.0.0.1:1") },
})
function Fixture() {
  const [outer, setOuter] = useState(false)
  const [inner, setInner] = useState(false)
  const { openConnectModal } = useConnectModal()
  return <>
    <button onClick={() => setOuter(true)}>Open sheet</button>
    {outer && <Modal title="Outer" onClose={() => setOuter(false)}>
      <input aria-label="Amount" defaultValue="25" />
      <button onClick={openConnectModal}>Connect wallet</button>
      <button onClick={() => setInner(true)}>Open nested</button>
      {inner && <Modal title="Inner" onClose={() => setInner(false)}>
        <button onClick={openConnectModal}>Connect nested wallet</button>
      </Modal>}
    </Modal>}
  </>
}
createRoot(document.getElementById("root")!).render(<StrictMode>
  <WagmiProvider config={config} reconnectOnMount={false}>
    <QueryClientProvider client={new QueryClient()}>
      <RainbowKitProvider><RainbowKitModalLayer><Fixture /></RainbowKitModalLayer></RainbowKitProvider>
    </QueryClientProvider>
  </WagmiProvider>
</StrictMode>)
