import { leavePage } from "../../platform/storage/walletStorage"
import { useEffect, useState, type ReactNode } from "react"
import {
  GradientInitialAvatar,
  GradientText,
  GradientToggle,
  Icon,
  IconCircle,
  RowChevron,
  SettingsRow,
  type IconName,
} from "@obsidion/web-ds"
import { useConfigValue } from "@obsidion/front-core"
import { getConfig } from "../../config/env"
import { loadWalletIdentity } from "../../features/identity/walletIdentity"
import { appVersion } from "../../lib/analytics"
import { BugReportModal, FeedbackModal } from "../FeedbackModals"
import { ContractAddressesModal } from "../ContractAddressesModal"
import { allowanceRowValue } from "../../features/allowance/allowanceView"
import { useSponsoredAllowance } from "../../features/allowance/useSponsoredAllowance"
import { WalletAboutLimitsSheet } from "../../features/limits/AboutLimitsSheet"
import { EndpointsModal, customEndpointsLabel } from "../EndpointsModal"
import { StrandedRecoveryModal } from "../../features/deposit/StrandedRecoveryModal"
import { RESET_PATH } from "../ResetScreen"
import { useHideBalances } from "../prefs"

// ponytail: hoist to config once a FAQ page exists.
const FAQ_URL = "https://docs.zk.money/docs/faq"
const X_URL = "https://x.com/zk_money"

function Trailing({ children, wrap = false }: { children: string; wrap?: boolean }) {
  const className = wrap
    ? "ww-settings__trailing ww-settings__trailing--wrap"
    : "ww-settings__trailing"
  return <span className={className}>{children}</span>
}

function ExternalLink({ icon, label, href }: { icon: IconName; label: string; href: string }) {
  return (
    <SettingsRow
      icon={icon}
      label={label}
      onClick={() => window.open(href, "_blank", "noopener")}
      trailing={<Icon name="share-box" size={16} color="var(--text-primary)" />}
    />
  )
}

function Section({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="ww-contacts__section">
      <span className="ww-contacts__label">{label}</span>
      <div className="ww-contacts__group">{children}</div>
    </div>
  )
}

/** Settings card: identity, feedback banner, general/others/socials groups, version. */
export function SettingsScreen() {
  const config = getConfig()
  const identity = loadWalletIdentity()
  const [hideBal, setHideBal] = useHideBalances()
  const { value: consent, setValue: setConsent } = useConfigValue("analyticsConsent")
  const [modal, setModal] = useState<
    "feedback" | "bug" | "contracts" | "allowance" | "limits" | "endpoints" | "recover"
  >()
  const allowance = useSponsoredAllowance()
  useEffect(() => {
    // Uses change with every sponsored batch, so each visit reads again.
    allowance.refresh()
    // eslint-disable-next-line react-hooks/exhaustive-deps -- read once per visit
  }, [])

  return (
    <div className="ww-panel ww-panel--settings">
      <div className="ww-panel__head">
        <GradientText size={24} weight={700}>
          Settings
        </GradientText>
      </div>
      <div className="ww-panel__scroll">
        <div className="ww-settings__user">
          <GradientInitialAvatar name={identity?.handle ?? "?"} size={80} />
          <GradientText gradient="title" size={24} weight={600}>
            @{identity?.handle ?? "unknown"}
          </GradientText>
          <span className="ww-settings__domain">.zk.money</span>
        </div>

        <div className="ww-settings__banners">
          <button
            type="button"
            className="zkm-btn-reset ww-settings__banner"
            onClick={() => setModal("bug")}
          >
            <IconCircle name="bug" glyphSize={24} />
            <span className="ww-settings__banner-text">
              <span>Report a bug</span>
            </span>
            <Icon name="chevron-right" size={16} color="#fff" />
          </button>

          <button
            type="button"
            className="zkm-btn-reset ww-settings__banner"
            onClick={() => setModal("feedback")}
          >
            <IconCircle name="megaphone" glyphSize={24} />
            <span className="ww-settings__banner-text">
              <span>Provide feedback to improve zk.money</span>
            </span>
            <Icon name="chevron-right" size={16} color="#fff" />
          </button>
        </div>

        <Section label="General">
          <SettingsRow
            icon="eye-off"
            label="Hide balance"
            trailing={<GradientToggle isOn={hideBal} onChange={setHideBal} />}
          />
          <SettingsRow
            icon="database"
            label="Share anonymous usage data"
            trailing={<GradientToggle isOn={consent} onChange={(on) => void setConsent(on)} />}
          />
          <SettingsRow
            icon="at"
            label="Tag"
            trailing={
              <>
                <Trailing>{identity ? `@${identity.handle}` : "—"}</Trailing>
                <Icon name="lock" size={16} color="var(--text-secondary)" />
              </>
            }
          />
          <SettingsRow
            icon="link"
            label="Network"
            trailing={<Trailing>{config.network}</Trailing>}
          />
          <SettingsRow
            icon="gift"
            label="Sponsored transactions"
            onClick={() => setModal("allowance")}
            trailing={
              <>
                <Trailing>{allowanceRowValue(allowance.snapshot)}</Trailing>
                <RowChevron />
              </>
            }
          />
          <SettingsRow
            icon="shield-check"
            label="Limits"
            onClick={() => setModal("limits")}
            trailing={<RowChevron />}
          />
        </Section>

        <Section label="Others">
          <ExternalLink icon="info-circle" label="FAQs" href={FAQ_URL} />
        </Section>

        <Section label="Socials">
          <ExternalLink icon="share" label="Follow us on X" href={X_URL} />
        </Section>

        <Section label="Advanced">
          <SettingsRow
            icon="file-copy"
            label="Contract addresses"
            onClick={() => setModal("contracts")}
            trailing={<RowChevron />}
          />
          <SettingsRow
            icon="link"
            label="Endpoints"
            onClick={() => setModal("endpoints")}
            trailing={
              <>
                <Trailing wrap>{customEndpointsLabel(config.endpoints) ?? "Default"}</Trailing>
                <RowChevron />
              </>
            }
          />
          <SettingsRow
            icon="tray-withdraw"
            label="Recover a Deposit"
            onClick={() => setModal("recover")}
            trailing={<RowChevron />}
          />
          <SettingsRow
            icon="trash"
            label="Clear local data"
            onClick={() => void leavePage(RESET_PATH, true)}
            trailing={<RowChevron />}
          />
        </Section>

        <span className="ww-settings__version">V {appVersion}</span>
      </div>

      {modal === "feedback" && <FeedbackModal onClose={() => setModal(undefined)} />}
      {modal === "bug" && <BugReportModal onClose={() => setModal(undefined)} />}
      {modal === "contracts" && <ContractAddressesModal onClose={() => setModal(undefined)} />}
      {modal === "allowance" && (
        <WalletAboutLimitsSheet topic="sponsorship" onClose={() => setModal(undefined)} />
      )}
      {modal === "limits" && <WalletAboutLimitsSheet onClose={() => setModal(undefined)} />}
      {modal === "endpoints" && <EndpointsModal onClose={() => setModal(undefined)} />}
      {modal === "recover" && <StrandedRecoveryModal onClose={() => setModal(undefined)} />}
    </div>
  )
}
