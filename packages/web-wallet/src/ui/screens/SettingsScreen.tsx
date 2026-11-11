import { leavePage } from "../../platform/storage/walletStorage"
import { useState, type ReactNode } from "react"
import { useNavigate } from "react-router-dom"
import {
  ComingSoonPill,
  GradientInitialAvatar,
  GradientText,
  GradientToggle,
  Icon,
  IconCircle,
  RowChevron,
  SettingsRow,
  StatusBadge,
  type IconName,
} from "@obsidion/web-ds"
import { useStore } from "@obsidion/front-core"
import { savePrefs, saveSetting } from "../../platform/storage/deviceKeys"
import { backupPasskeySettingsEnabled } from "../../config/features"
import { useSession } from "../../session/session"
import { appVersion } from "../../lib/analytics"
import { BugReportModal, FeedbackModal } from "../FeedbackModals"
import { ContractAddressesModal } from "../ContractAddressesModal"
import { PasskeysSheet } from "../PasskeysSheet/PasskeysSheet"
import { useBackupRotation } from "../../features/backupPasskey/backupRotations"
import {
  BackupNudgeBadge,
  SettingsBackupNudge,
} from "../../features/backupPasskey/BackupNudge/BackupNudge"
import { allowanceRowValue } from "../../features/allowance/allowanceView"
import { useSponsoredAllowance } from "../../features/allowance/useSponsoredAllowance"
import { WalletAboutLimitsSheet } from "../../features/limits/AboutLimitsSheet"
import { EndpointsModal, customEndpointsLabel } from "../EndpointsModal"
import { StrandedRecoveryModal } from "../../features/deposit/recovery/StrandedRecoveryModal/StrandedRecoveryModal"
import { NON_CONTACT_REQUESTS_PATH } from "../../features/requests/nonContactView"
import { useNonContactRequests } from "../../features/requests/useNonContactRequests"
import { RESET_PATH } from "../ResetScreen"
import { ConfigProfileModal } from "../../dev/ConfigProfileModal"
import { useRegistrationTagChangeable } from "../../features/registration/openRegistration"
import { ChooseNameSheet } from "../../features/deposit/ChooseNameSheet/ChooseNameSheet"
import { claimChosenName } from "../../features/onboarding/oxideOnboarding"
import { selectHistoryRow } from "../../features/backupPasskey/accountHistory"
import { AccountHistorySheet } from "../../features/backupPasskey/AccountHistorySheet/AccountHistorySheet"
import historyCopy from "../../features/backupPasskey/AccountHistorySheet/AccountHistorySheet.copy"

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

function Section({ label, children }: { label: ReactNode; children: ReactNode }) {
  return (
    <div className="ww-contacts__section">
      <span className="ww-contacts__label">{label}</span>
      <div className="ww-contacts__group">{children}</div>
    </div>
  )
}

/** Settings card: identity, feedback banner, general/others/socials groups, version. */
export function SettingsScreen() {
  const navigate = useNavigate()
  const { database, device, identity: entered, page } = useSession()
  const { config } = page
  const hideBal = useStore(device, (s) => s.hideBalances)
  const identity = useStore(entered).value
  const consent = useStore(device, (s) => s.analyticsConsent)
  const nonContact = useNonContactRequests()
  const [modal, setModal] = useState<
    | "feedback"
    | "bug"
    | "contracts"
    | "allowance"
    | "limits"
    | "endpoints"
    | "recover"
    | "config"
    | "name"
    | "passkeys"
    | "history"
  >()
  const tagChangeable = useRegistrationTagChangeable()
  const allowance = useSponsoredAllowance()
  const backupRotation = useBackupRotation()
  const historyRow = useStore(useSession().accountHistory, selectHistoryRow)

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

        <SettingsBackupNudge onAdd={() => setModal("passkeys")} />

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
            trailing={
              <GradientToggle
                isOn={hideBal}
                onChange={(on) => savePrefs(database, { hideBalances: String(on) })}
              />
            }
          />
          <SettingsRow
            icon="database"
            label="Share anonymous usage data"
            trailing={
              <GradientToggle
                isOn={consent}
                onChange={(on) => void saveSetting(database, "analyticsConsent", on)}
              />
            }
          />
          <SettingsRow
            icon="at"
            label="Tag"
            trailing={
              <>
                <Trailing>{identity ? `@${identity.handle}` : "—"}</Trailing>
                {tagChangeable ? (
                  <button
                    type="button"
                    className="zkm-btn-reset ww-deposit__link"
                    onClick={() => setModal("name")}
                  >
                    Change
                  </button>
                ) : (
                  <Icon name="lock" size={16} color="var(--text-secondary)" />
                )}
              </>
            }
          />
          <SettingsRow
            icon="key"
            label="Passkeys"
            onClick={() => setModal("passkeys")}
            trailing={
              <>
                {backupRotation && typeof backupRotation === "object" && (
                  <StatusBadge label="Pending" badgeStyle="pending" />
                )}
                <BackupNudgeBadge />
                <RowChevron />
              </>
            }
          />
          {/* Only adding a backup passkey makes an entry. */}
          {(backupPasskeySettingsEnabled || historyRow !== "none") && (
            <SettingsRow
              icon="history-clock"
              label={historyCopy.title}
              onClick={() => setModal("history")}
              trailing={
                <>
                  {historyRow === "found" ? (
                    <StatusBadge label={historyCopy.row.found} badgeStyle="paid" />
                  ) : (
                    <Trailing>{historyCopy.row[historyRow]}</Trailing>
                  )}
                  <RowChevron />
                </>
              }
            />
          )}
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

        <Section
          label={
            <span className="ww-settings__label">
              Payment requests
              <ComingSoonPill label="New" />
            </span>
          }
        >
          <SettingsRow
            icon="contacts-line"
            label="Allow requests from people not in your contacts"
            className="ww-settings__described"
            description={
              <>
                <span>
                  Anyone who knows your tag can ask you for funds. Their requests go to a separate
                  inbox in Contacts, never to Activity or notifications. Turn this off to block
                  them.
                </span>
                {nonContact.requests.length > 0 && (
                  <button
                    type="button"
                    className="zkm-btn-reset zkm-pressable ww-settings__pending"
                    onClick={() => navigate(NON_CONTACT_REQUESTS_PATH)}
                  >
                    {nonContact.requests.length} pending
                    <Icon name="arrow-right-s-line" size={11} />
                  </button>
                )}
              </>
            }
            trailing={
              <GradientToggle
                isOn={nonContact.allowed}
                onChange={(on) => void nonContact.setAllowed(on)}
              />
            }
          />
        </Section>

        <Section label="Others">
          <ExternalLink icon="info-circle" label="FAQs" href={FAQ_URL} />
        </Section>

        <Section label="Socials">
          <ExternalLink icon="share" label="Follow us on X" href={X_URL} />
        </Section>

        <Section label="Advanced">
          {import.meta.env.VITE_CONFIG_EDITOR === "true" && (
            <SettingsRow
              icon="pencil"
              label="Config profile"
              onClick={() => setModal("config")}
              trailing={<RowChevron />}
            />
          )}
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
      {modal === "passkeys" && <PasskeysSheet onClose={() => setModal(undefined)} />}
      {modal === "history" && <AccountHistorySheet onClose={() => setModal(undefined)} />}
      {modal === "allowance" && (
        <WalletAboutLimitsSheet
          topic="sponsorship"
          capacity={false}
          onClose={() => setModal(undefined)}
        />
      )}
      {modal === "limits" && (
        <WalletAboutLimitsSheet capacity={false} onClose={() => setModal(undefined)} />
      )}
      {modal === "endpoints" && (
        <EndpointsModal config={config} onClose={() => setModal(undefined)} />
      )}
      {import.meta.env.VITE_CONFIG_EDITOR === "true" && modal === "config" && (
        <ConfigProfileModal onClose={() => setModal(undefined)} />
      )}
      {modal === "recover" && <StrandedRecoveryModal onClose={() => setModal(undefined)} />}
      {modal === "name" && identity?.handle && (
        <ChooseNameSheet
          tag={identity.handle}
          claim={claimChosenName}
          onClose={() => setModal(undefined)}
        />
      )}
    </div>
  )
}
