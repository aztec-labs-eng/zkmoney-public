/**
 * Withdraw on a deployment whose portal is frozen: refunds all the account's funds to the user's own
 * L1 wallet, which sends each refund itself. There is no amount to choose.
 */
import { useState } from "react"
import { useNavigate } from "react-router-dom"
import { isAddress, type Address } from "viem"
import { useAccountContext, useAztecContext, useSavingsPosition } from "@obsidion/front-core"
import { PrimaryGradientButton } from "@obsidion/web-ds"
import { getConfig } from "../../config/env"
import { l1PublicClient } from "../../config/oxideTuple"
import { showReportableError } from "../../errors/errorModal"
import { isDesktopL1SubmitActive } from "../../platform/desktopBridge"
import { usdAtomicFloor } from "../../ui/format"
import { useScreenedAddress } from "../../ui/screening"
import { isWalletRejection, useL1Wallet } from "../deposit/l1Wallet"
import {
  desktopBridgeChannel,
  injectedWalletChannel,
  type L1ExitStage,
} from "../deposit/sipaRecovery"
import { SAVINGS_ASSET } from "../savings/savingsGateway"
import { ExitWalletRow } from "./ExitWalletRow"
import { frozenExitRuntime, frozenSavingsRuntime, recordFrozenRefund } from "./frozenExit"
import {
  Eyebrow,
  FrozenExitApprove,
  FrozenExitCard,
  FrozenExitDoneCard,
  FrozenExitPreparing,
  FrozenWalletRoute,
  HashRows,
  HowToSend,
  Lead,
  step,
  TextButton,
  Title,
  type FrozenExitDone,
  type FrozenExitSent,
} from "./frozenExitParts"
import { runFrozenExit, type FrozenExitRuntime } from "./frozenExitRun"
import { scanFrozenFunds, sharesUsd, useFrozenFunds } from "./frozenFunds"
import { usePortalFrozen } from "./portalFrozen"

export function FrozenExitScreen() {
  const config = getConfig()
  const navigate = useNavigate()
  const { obsidionWallet } = useAztecContext()
  const { obsidionAccount } = useAccountContext()
  const l1 = useL1Wallet({ expectedChainId: config.l1ChainId, rpcUrl: config.l1RpcUrl })
  const bridgeMode = isDesktopL1SubmitActive()
  // The build can freeze before its portal does, and refunds need the frozen portal.
  const portalFrozen = usePortalFrozen()
  const { funds, failed, rescan } = useFrozenFunds({ rescanOnMount: true })
  const sharePrice = useSavingsPosition().position?.sharePrice
  const [destination, setDestination] = useState("")
  const [stage, setStage] = useState<L1ExitStage | "proving">()
  const [sent, setSent] = useState<FrozenExitSent>()
  const [done, setDone] = useState<FrozenExitDone>()

  const chain =
    obsidionWallet && obsidionAccount ? { wallet: obsidionWallet, account: obsidionAccount } : null
  const shareUsd = (shares: bigint) => sharesUsd(shares, sharePrice)

  // The desktop helper page picks its account after the refund is proven, so the user names it and
  // the helper refuses any other payer.
  const to = bridgeMode
    ? isAddress(destination)
      ? (destination as Address)
      : null
    : l1.wrongChain
    ? null
    : l1.account
  const screening = useScreenedAddress(to, "withdraw")
  const refundable = !!funds && funds.main.refundable + (funds.savings?.refundable ?? 0n) > 0n
  const ready = !!chain && !!to && screening.cleared && refundable
  const home = () => navigate("/")

  const submit = async () => {
    if (!chain || !to || !funds) return
    setStage("proving")
    setSent(undefined)
    const progress: FrozenExitSent = { refunded: 0n, hashes: [] }
    // Savings with nothing refundable yet still has what waits.
    let left = funds.savings && !funds.savings.refundable ? shareUsd(funds.savings.waiting) : 0n
    try {
      const channel = bridgeMode
        ? desktopBridgeChannel({
            destination: to,
            from: to,
            chainId: config.l1ChainId,
            publicClient: l1PublicClient(config),
            display: { title: "Withdraw from zk.money", lines: [["To", to]] },
            onStage: setStage,
          })
        : await injectedWalletChannel(config, { from: to, onStage: setStage })
      // Main first, then Savings, which pays out its own token.
      const sources: Array<{
        runtime: () => Promise<FrozenExitRuntime | undefined>
        main: boolean
      }> = [
        { runtime: () => frozenExitRuntime(chain, to), main: true },
        ...(funds.savings?.refundable
          ? [{ runtime: () => frozenSavingsRuntime(chain, to), main: false }]
          : []),
      ]
      for (const source of sources) {
        const runtime = await source.runtime()
        if (!runtime) continue
        let before = 0n
        const usd = (amount: bigint) => (source.main ? amount : shareUsd(amount))
        const result = await runFrozenExit(runtime, channel, (batch) => {
          const hash = batch.hashes[batch.hashes.length - 1]!
          const amount = batch.refunded - before
          void recordFrozenRefund({
            hash,
            amount,
            to,
            ...(source.main ? {} : { usd: usd(amount), symbol: SAVINGS_ASSET }),
          }).catch((e) => console.warn("[frozen-exit] refund record failed:", e))
          progress.refunded += usd(amount)
          progress.hashes.push(hash)
          before = batch.refunded
          setSent({ ...progress, hashes: [...progress.hashes] })
          setStage("proving")
          void scanFrozenFunds(chain, true)
        })
        left += usd(result.stranded + result.waiting)
      }
      setDone({ ...progress, left, to })
    } catch (e) {
      if (!isWalletRejection(e))
        showReportableError(e, "withdraw:frozen-refund", { title: "Withdrawal stopped" })
    } finally {
      setStage(undefined)
      void scanFrozenFunds(chain, true)
    }
  }

  if (done) return <FrozenExitDoneCard done={done} onClose={home} />
  if (stage === "proving") return <FrozenExitPreparing sent={sent} bridgeMode={bridgeMode} />
  if (stage) return <FrozenExitApprove stage={stage} sent={sent} bridgeMode={bridgeMode} />

  const connect = !bridgeMode && (!l1.account || l1.wrongChain)
  return (
    <FrozenExitCard>
      <Eyebrow>{step(1)}</Eyebrow>
      <Title>Review your withdrawal</Title>
      <Lead>
        Everything moves at once. The gas is paid in ETH from your wallet. Large balances need more
        than one transfer.
      </Lead>
      <HowToSend />
      <FrozenWalletRoute
        bridgeMode={bridgeMode}
        wallet={<ExitWalletRow l1={l1} chainName={config.l1Chain.name} />}
        destination={destination}
        onDestination={setDestination}
        to={to}
        screening={screening}
        status={
          !portalFrozen
            ? "Waiting for network"
            : funds
            ? undefined
            : failed
            ? "Couldn't find your funds"
            : "Finding your funds…"
        }
        funds={funds}
        shareUsd={shareUsd}
        savingsSymbol={SAVINGS_ASSET}
      />
      {sent && (
        <>
          <p className="ww-sheet__note">
            {usdAtomicFloor(sent.refunded)} already sent. Withdraw again to send the rest.
          </p>
          <HashRows hashes={sent.hashes} />
        </>
      )}
      {failed ? (
        <PrimaryGradientButton
          title="Try again"
          onClick={rescan}
          style={{ width: "100%", height: 48 }}
        />
      ) : connect ? (
        <PrimaryGradientButton
          title={l1.account ? `Switch to ${config.l1Chain.name}` : "Connect your wallet"}
          isDisabled={l1.connecting}
          onClick={() => void (l1.account ? l1.switchNetwork() : l1.connect())}
          style={{ width: "100%", height: 48 }}
        />
      ) : (
        <PrimaryGradientButton
          title="Confirm withdrawal"
          isDisabled={!ready}
          onClick={() => void submit()}
          style={{ width: "100%", height: 48 }}
        />
      )}
      <TextButton onClick={home}>Back</TextButton>
    </FrozenExitCard>
  )
}
