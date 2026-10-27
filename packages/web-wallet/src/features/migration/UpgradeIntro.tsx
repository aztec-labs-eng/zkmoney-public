import { GradientText, Icon } from "@obsidion/web-ds"
import badge from "../../assets/migration/upgrade-badge.webp"
import { openMigrationDialog, useUpgradeStatus } from "./migrationDialog"
import { keepOpenCopy, upgradeBannerCopy } from "./upgradeCopy"
import { usePhoneLayout } from "../../ui/usePhoneLayout"
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

/** A closed or suspended page stops the upgrade's proofs and sends. */
export function UpgradeKeepOpen() {
  const phone = usePhoneLayout()
  return (
    <div className="ww-upgrade__keep-open" role="note" data-testid="upgrade-keep-open">
      <Icon name="alert-triangle" size={20} />
      <span>
        <strong>{keepOpenCopy.title}</strong>
        {phone ? keepOpenCopy.phone : keepOpenCopy.desktop}
      </span>
    </div>
  )
}

/** Home's banner while the account has an upgrade to make, finish or follow; it opens the dialog. */
export function UpgradeBanner() {
  const copy = upgradeBannerCopy(useUpgradeStatus())
  if (!copy) return null
  return (
    <button
      type="button"
      className={`zkm-btn-reset ww-banner ww-banner--upgrade${copy.cta ? " ww-banner--offer" : ""}`}
      data-testid="upgrade-banner"
      onClick={() => openMigrationDialog()}
    >
      <span className="ww-banner__badge">
        <img src={badge} alt="" />
      </span>
      <span className="ww-banner__text">
        <span className="ww-banner__title">{copy.title}</span>
        {copy.body && <span className="ww-banner__body">{copy.body}</span>}
        {copy.cta && <span className="ww-banner__cta">{copy.cta}</span>}
      </span>
    </button>
  )
}

/** The caution on every screen, so it stays once the dialog closes. */
export function UpgradeKeepOpenBanner() {
  if (!useUpgradeStatus().keepOpen) return null
  return (
    <div className="ww-upgrade__keep-open-bar">
      <UpgradeKeepOpen />
    </div>
  )
}
