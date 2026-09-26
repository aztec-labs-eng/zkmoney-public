import { useState, type ReactNode } from "react"
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
import { RESET_PATH } from "../ResetScreen"
import { useHideBalances } from "../prefs"

// ponytail: hoist to config once a FAQ page exists.
const FAQ_URL = "https://docs.zk.money/docs/faq"
const X_URL = "https://x.com/zk_money"

function Trailing({ children }: { children: string }) {
  return <span className="ww-settings__trailing">{children}</span>
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
  const [modal, setModal] = useState<"feedback" | "bug" | "contracts">()

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
            icon="trash"
            label="Clear local data"
            onClick={() => location.replace(RESET_PATH)}
            trailing={<RowChevron />}
          />
        </Section>

        <span className="ww-settings__version">V {appVersion}</span>
      </div>

      {modal === "feedback" && <FeedbackModal onClose={() => setModal(undefined)} />}
      {modal === "bug" && <BugReportModal onClose={() => setModal(undefined)} />}
      {modal === "contracts" && <ContractAddressesModal onClose={() => setModal(undefined)} />}
    </div>
  )
}
