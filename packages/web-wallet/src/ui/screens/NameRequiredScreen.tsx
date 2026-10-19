import { useNavigate } from "react-router-dom"
import { Card, PrimaryGradientButton } from "@obsidion/web-ds"
import {
  openMigrationDialog,
  useRegistrationMigrationNeeded,
} from "../../features/migration/migrationDialog"
import { UpgradeIntro } from "../../features/migration/UpgradeIntro"

/**
 * Shown in place of a sponsored action the ClaimFPC cannot bill yet. Its open rail admits an
 * account the L1 registry registered, so the action waits for a name (`pending` unset) or for the
 * NamePortal's L1->L2 message to reach the rollup (`pending`). On a new version that message comes
 * from the account's upgrade, so the screen offers it. The user reaches this by attempting the
 * action, not before.
 */
export function NameRequiredScreen({ pending }: { pending?: boolean }) {
  const navigate = useNavigate()
  const update = useRegistrationMigrationNeeded() && !!pending
  // The action waits on the upgrade (Figma 12709:37036).
  if (update)
    return (
      <div style={{ padding: 24, maxWidth: 520, margin: "0 auto" }}>
        <Card padding={20}>
          <div data-testid="registration-update" className="ww-migration">
            <UpgradeIntro
              title="Upgrade to send"
              lead="Upgrade to send and receive faster. Your balance stays safe."
            />
            <PrimaryGradientButton title="Upgrade now" onClick={openMigrationDialog} />
            <button
              type="button"
              className="zkm-btn-reset ww-migration__later"
              onClick={() => navigate("/")}
            >
              Maybe later
            </button>
          </div>
        </Card>
      </div>
    )
  return (
    <div style={{ padding: 24, maxWidth: 520, margin: "0 auto" }}>
      <Card padding={20}>
        <div
          data-testid={pending ? "registration-pending" : "name-required"}
          style={{ display: "flex", flexDirection: "column", gap: 12 }}
        >
          <span
            className="zkm-type-card-title"
            style={{ color: "var(--text-primary)", fontFamily: "var(--font-display)" }}
          >
            {pending ? "Finishing your registration" : "Register a name first"}
          </span>
          <span className="zkm-type-body-sm" style={{ color: "var(--text-secondary)" }}>
            {pending
              ? "Sending, withdrawing and payment links unlock as soon as your registration reaches the network. This takes a few minutes."
              : "Sending, depositing and withdrawing are paid for by your registration. Register a name to unlock them."}
          </span>
          {!pending && (
            <PrimaryGradientButton title="Register a name" onClick={() => navigate("/claim")} />
          )}
          <button
            type="button"
            className="zkm-btn-reset ww-invite__link"
            style={{ width: "fit-content", alignSelf: "center", fontSize: 14 }}
            onClick={() => navigate("/")}
          >
            Back to wallet
          </button>
        </div>
      </Card>
    </div>
  )
}
