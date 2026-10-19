import { GradientText } from "@obsidion/web-ds"
import badge from "../../assets/migration/upgrade-badge.webp"
import { openMigrationDialog, useUpgradeOffered } from "./migrationDialog"
import "./migration.css"

/** How each sheet that offers the upgrade opens (Figma 12709:36185). */
export function UpgradeIntro({ title, lead }: { title: string; lead: string }) {
  return (
    <>
      <img className="ww-upgrade__badge" src={badge} alt="" />
      <GradientText gradient="title" size={24} weight={700} style={{ textAlign: "center" }}>
        {title}
      </GradientText>
      <p className="ww-migration__lead">{lead}</p>
    </>
  )
}

/** Home's offer of the upgrade while the account has one to make (Figma 12709:35478). */
export function UpgradeBanner() {
  if (!useUpgradeOffered()) return null
  return (
    <button
      type="button"
      className="zkm-btn-reset ww-banner ww-banner--upgrade"
      data-testid="upgrade-banner"
      onClick={openMigrationDialog}
    >
      <img src={badge} alt="" />
      <span className="ww-banner__text">
        <span className="ww-banner__title">Faster zk.money available</span>
        <span className="ww-banner__body">
          Same wallet, but quicker transactions. Tap to upgrade.
        </span>
      </span>
    </button>
  )
}
