import { Glass } from "@samasante/liquid-glass"
import { Icon } from "./Icon"

export interface TabConfig {
  name: string
  label: string
  /** Icon name — the app uses "home", "send", "history-clock", "payments-arrows", "person", "receive". */
  icon: string
}

export interface TabBarProps {
  tabs: TabConfig[]
  activeTab: string
  onTabChange?: (name: string) => void
  className?: string
}

/** Optics for the sliding active-tab lens: thin frost, gentle bend, strong RGB split. */
const INDICATOR_OPTICS = { frost: 2, strength: 0.08, dispersion: 0.5 }

/** Horizontal overhang of the lens past the active tab cell, per side. */
const LENS_OVERHANG = 3
/** Bar side padding budgets for the overhang; must match .zkm-tab-bar's side padding. */
const BAR_SIDE_PAD = 4 + LENS_OVERHANG

/**
 * Bottom pill tab bar with a sliding liquid-glass indicator. 63px capsule
 * chrome; both the bar and the indicator are live glass (@samasante/liquid-glass):
 * Chrome/Edge bend the backdrop, Safari/Firefox get frost + tint + edge light.
 */
export function TabBar({ tabs, activeTab, onTabChange, className }: TabBarProps) {
  const n = tabs.length
  const activeIndex = Math.max(
    0,
    tabs.findIndex((t) => t.name === activeTab),
  )
  // Glass pins display:inline-block inline, so the flex layout must come through the style prop.
  return (
    <Glass
      className={["zkm-tab-bar", className].filter(Boolean).join(" ")}
      style={{ display: "flex" }}
    >
      <Glass
        className="zkm-tab-bar__indicator"
        optics={INDICATOR_OPTICS}
        style={{
          // Glass only honors position from the style prop (it pins relative inline otherwise).
          position: "absolute",
          left: `${BAR_SIDE_PAD - LENS_OVERHANG}px`,
          width: `calc((100% - ${2 * BAR_SIDE_PAD}px - ${16 * (n - 1)}px) / ${n} + ${2 * LENS_OVERHANG}px)`,
          // translateX % is relative to the lens's own (overhung) width, so the
          // per-tab step trims the overhang back out: lensW + (gap - 2*overhang) = tabW + gap.
          transform: `translateX(calc(${activeIndex} * (100% + ${16 - 2 * LENS_OVERHANG}px)))`,
        }}
      />
      {tabs.map((t) => {
        const active = t.name === activeTab
        return (
          <button
            key={t.name}
            type="button"
            className={`zkm-btn-reset zkm-tab-bar__tab${active ? " zkm-tab-bar__tab--active" : ""}`}
            onClick={() => onTabChange?.(t.name)}
            aria-current={active || undefined}
          >
            <span className="zkm-tab-bar__icon">
              <Icon name={t.icon} size={t.icon === "person" ? 21 : 20} />
            </span>
            <span className="zkm-tab-bar__label">{t.label}</span>
          </button>
        )
      })}
    </Glass>
  )
}

/** Positions a TabBar at the bottom of a screen with the dark halo glow behind it. */
export function TabBarShell({ tabs, activeTab, onTabChange, className }: TabBarProps) {
  return (
    <div className={["zkm-tab-shell", className].filter(Boolean).join(" ")}>
      <div className="zkm-tab-shell__halo" />
      <TabBar tabs={tabs} activeTab={activeTab} onTabChange={onTabChange} />
    </div>
  )
}
