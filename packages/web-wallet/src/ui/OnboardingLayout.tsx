import type { ReactNode } from "react"
import { Outlet } from "react-router-dom"
import { AuroraBackground, GradientText, Icon } from "@obsidion/web-ds"
import "./shell.css"

/**
 * Public landing: brand panel (aurora, wordmark) beside a centered sheet card hosting the
 * content — the 404, and `/link#…` once it has an account to act with. The panel hides under
 * 960px; the pane keeps its own aurora so the card never sits on a flat black canvas.
 *
 * Usable as a route layout (children come from the Outlet) or wrapped around content directly.
 */
export function OnboardingLayout({ children }: { children?: ReactNode }) {
  return (
    <div className="ww-onboard">
      <div className="ww-onboard__brand">
        <AuroraBackground style={{ position: "absolute", inset: 0 }} />
        <div className="ww-onboard__brand-row">
          <Icon name="lock-shield" size={20} color="#A000FF" />
          <GradientText gradient="brand" size={18} weight={700}>
            zk.money
          </GradientText>
        </div>
      </div>
      <div className="ww-onboard__pane">
        <AuroraBackground style={{ position: "absolute", inset: 0 }} />
        <div className="ww-onboard-card">{children ?? <Outlet />}</div>
      </div>
    </div>
  )
}
