import { HomeQuickActionsRow, Icon } from "@obsidion/web-ds"
import { PhoneIcon, type PhoneIconName } from "../PhoneIcon"

export interface HomeAction {
  title: string
  icon: string
  /** The phone glyph where one exists; the desktop icon stands in otherwise. */
  phoneIcon?: PhoneIconName
  run: () => void
}

/** The wallet card's action tiles: the phone row with its glyphs, or the design system's row. */
export function HomeActions({ actions, phone }: { actions: HomeAction[]; phone: boolean }) {
  if (!phone) {
    return (
      <HomeQuickActionsRow
        actions={actions.map(({ title, icon, run }) => ({ title, icon, onClick: run }))}
      />
    )
  }
  return (
    <div className="zkm-quick-actions ww-home__phone-actions">
      {actions.map((action) => (
        <button
          key={action.title}
          type="button"
          className="zkm-btn-reset zkm-quick-action zkm-pressable"
          onClick={action.run}
        >
          <span className="zkm-quick-action__tile">
            {action.phoneIcon ? (
              <PhoneIcon name={action.phoneIcon} size={32} />
            ) : (
              <Icon name={action.icon} size={32} />
            )}
          </span>
          <span className="zkm-quick-action__caption">{action.title}</span>
        </button>
      ))}
    </div>
  )
}
