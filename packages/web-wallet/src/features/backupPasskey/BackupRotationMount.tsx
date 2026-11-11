/**
 * Drives the session's saved backup-passkey rotation on every wallet route once the PXE is up and
 * the first balance is in, so it advances with Settings closed and after a reload.
 */
import { useEffect } from "react"
import { serviceStatus, useAfter, useStore, type After } from "@obsidion/front-core"
import type { Address } from "viem"
import { handOffAccount, useSession } from "../../session/session"
import { usePxeBoot } from "../../ui/PxeBoot"
import { warnFailure } from "./backupFailure"
import { buildBackupFlowDeps } from "./backupPasskeyRuntime"
import { getRotationDriver, ownsRotation } from "./rotationDrive"

const AFTER: After = { firstBalance: true }
export function BackupRotationMount(): null {
  const session = useSession()
  const walletBuilt = useStore(session.wallet, serviceStatus) === "ready"
  const booted = usePxeBoot(session.page).bootStatus === "ready"
  const { milestones, identity, backupRotations } = session
  const ready = useAfter(milestones, AFTER)
  // eslint-disable-next-line local/effect-hook -- ZKM-1806
  useEffect(() => {
    if (!booted || !ready || !walletBuilt || !backupRotations) return
    const driver = getRotationDriver()
    driver.start({
      store: backupRotations,
      deps: (owner) =>
        buildBackupFlowDeps({
          session,
          owner: owner as Address,
          switchAccount: (account) => handOffAccount(session, account),
        }),
      owns: (record) => ownsRotation(record, identity.get().value?.address),
      report: warnFailure,
      pace: session.page.pace,
    })
    return () => driver.stop()
  }, [booted, ready, walletBuilt, identity, backupRotations, session])
  return null
}
