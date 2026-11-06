import { useState } from "react"
import { formatUnits, isAddress, type Address } from "viem"
import { ConfirmationSheetDetailRow, TextField } from "@obsidion/web-ds"
import { getConfig } from "../../../config/env"
import { l1PublicClient } from "../../../config/oxideTuple"
import { showReportableError } from "../../../errors/errorModal"
import { failureCode, fireEvent } from "../../../lib/analytics"
import { fmt } from "../../../lib/fmt"
import { isDesktopL1SubmitActive } from "../../../platform/desktopBridge"
import { shortL1Addr } from "../../../ui/format"
import { ScreeningNotice, useScreenedAddress } from "../../../ui/screening"
import { TextButton } from "../../cutover/parts"
import { openMigrationDialog } from "../../migration/migrationDialog"
import { SourceBusyError } from "../../migration/migrationErrors"
import { isFlowCancelled, runOperation } from "../../operations/operations"
import { ManualExitSheet } from "../../withdraw/ManualExitSheet"
import { useL1Wallet } from "../../../session/l1Wallet"
import copy from "./FrozenDepositRefundModal.copy"
import { refundFrozenDeposit } from "./frozenDepositRefund"
import type { StrandedFrozenDeposit } from "./sipaRecovery"
import { desktopBridgeChannel, injectedWalletChannel } from "../../sipa/l1ExitChannels"

/** Refunds a previous version's deposit stuck in its frozen portal, or hands it to the upgrade. */
export function FrozenDepositRefundModal({
  found: { record, frozen },
  onClose,
}: {
  found: StrandedFrozenDeposit
  onClose: () => void
}) {
  const config = getConfig()
  const bridgeMode = isDesktopL1SubmitActive()
  const l1 = useL1Wallet({ expectedChainId: config.l1ChainId, rpcUrl: config.l1RpcUrl })
  const [typed, setTyped] = useState("")
  const [paid, setPaid] = useState<{ amount: bigint; to: Address }>()
  const typedValid = isAddress(typed.trim())
  // Empty pays the connected wallet. The desktop helper picks its payer later, so it needs one typed.
  const target = typedValid
    ? (typed.trim() as Address)
    : typed || bridgeMode || l1.wrongChain
    ? null
    : l1.account
  const { verdict, cleared, rescreen } = useScreenedAddress(target, "deposit-exit")
  const units = (amount: bigint) =>
    fmt(copy.units, { amount: formatUnits(amount, frozen.decimals), symbol: frozen.symbol })

  return (
    <ManualExitSheet
      label={copy.title}
      title={copy.title}
      doneTitle={copy.doneTitle}
      explainer={copy.intro}
      facts={
        <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
          <TextField
            label={copy.sendTo}
            placeholder={bridgeMode ? copy.placeholderBridge : copy.placeholder}
            value={typed}
            onChange={setTyped}
            error={typed && !typedValid ? copy.invalidAddress : undefined}
          />
          {target && !cleared && (
            <ScreeningNotice
              verdict={verdict}
              checkingCopy={copy.screening.checking}
              blockedFallback={copy.screening.blocked}
              errorCopy={copy.screening.error}
              onRetry={rescreen}
            />
          )}
          <div>
            <ConfirmationSheetDetailRow label={copy.amount} value={units(frozen.amount)} />
            <ConfirmationSheetDetailRow
              label={copy.depositAddress}
              value={shortL1Addr(record.sipaAddress)}
            />
            <ConfirmationSheetDetailRow
              label={copy.to}
              value={target ? shortL1Addr(target) : "—"}
            />
            <ConfirmationSheetDetailRow label={copy.network} value={config.l1Chain.name} />
          </div>
        </div>
      }
      buttonTitle={copy.refund}
      blocked={!target || !cleared}
      preparing={copy.proving}
      secondary={
        <TextButton
          onClick={() => {
            onClose()
            openMigrationDialog()
          }}
        >
          {copy.moveInstead}
        </TextButton>
      }
      run={({ from, onHelperOpened, onStage, nextRequest }) =>
        runOperation(
          { operationId: crypto.randomUUID(), flow: "withdraw", summary: copy.operationSummary },
          async () => {
            const to = target as Address
            const channel = bridgeMode
              ? desktopBridgeChannel({
                  destination: to,
                  chainId: config.l1ChainId,
                  publicClient: l1PublicClient(config),
                  display: { title: copy.helperTitle, lines: [[copy.to, to]] },
                  onHelperOpened,
                  onStage,
                })
              : await injectedWalletChannel(config, { from, onStage })
            const result = await refundFrozenDeposit(frozen, to, channel, nextRequest)
            setPaid({ amount: result.refunded, to })
            return result.hashes
          },
        )
      }
      refusal={(e) => (e instanceof SourceBusyError ? copy.upgradeBusy : undefined)}
      onError={(e) => {
        if (isFlowCancelled(e)) return
        fireEvent("action_failed", { action: "deposit:recover", code: failureCode(e) })
        showReportableError(e, "deposit:frozen-refund", { title: copy.stopped })
      }}
      done={paid && fmt(copy.done, { amount: units(paid.amount), to: shortL1Addr(paid.to) })}
      onClose={onClose}
    />
  )
}
