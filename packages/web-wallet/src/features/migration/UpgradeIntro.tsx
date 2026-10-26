import { GradientText } from "@obsidion/web-ds"
import badge from "../../assets/migration/upgrade-badge.webp"
import { openMigrationDialog, useUpgradeStatus } from "./migrationDialog"
import { upgradeBannerCopy } from "./upgradeCopy"
import "./migration.css"

/** How each sheet that offers the upgrade opens (Figma 12709:36185). */
export function UpgradeIntro({ title, lead }: { title: string; lead: string }) {
  return (
    <>
      <img className="ww-upgrade__badge" src={badge} alt="" />
      <GradientText gradient="title" size={24} weight={700} className="ww-upgrade__title">
        {title}
      </GradientText>
      <p className="ww-migration__lead ww-upgrade__lead">{lead}</p>
    </>
  )
}

/** Home's banner while the account has an upgrade to make, finish or follow; it opens the dialog. */
export function UpgradeBanner() {
  const copy = upgradeBannerCopy(useUpgradeStatus())
  if (!copy) return null
  return (
    <button
      type="button"
      className="zkm-btn-reset ww-banner ww-banner--upgrade"
      data-testid="upgrade-banner"
      onClick={() => openMigrationDialog()}
    >
      <img src={badge} alt="" />
      <span className="ww-banner__text">
        <span className="ww-banner__title">{copy.title}</span>
        {copy.body && <span className="ww-banner__body">{copy.body}</span>}
      </span>
    </button>
  )
}
