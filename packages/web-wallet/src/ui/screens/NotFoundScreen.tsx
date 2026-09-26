import { GradientText, Icon, PrimaryGradientButton } from "@obsidion/web-ds"
import { useNavigate } from "react-router-dom"

/** Catch-all for unknown routes. Mounted outside AccountGate so it never waits on PXE boot. */
export function NotFoundScreen() {
  const navigate = useNavigate()
  return (
    <div
      style={{
        flex: 1,
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        gap: 16,
        textAlign: "center",
        padding: "24px 0",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <Icon name="lock-shield" size={18} color="#A000FF" />
        <GradientText gradient="brand" size={18} weight={700}>
          zk.money
        </GradientText>
      </div>
      <GradientText gradient="title" size={28} weight={700}>
        Page not found
      </GradientText>
      <span className="zkm-type-body" style={{ color: "var(--text-secondary)", maxWidth: 300 }}>
        The page you&rsquo;re looking for doesn&rsquo;t exist or has moved.
      </span>
      <div style={{ width: "100%", maxWidth: 300, marginTop: 8 }}>
        <PrimaryGradientButton title="Go to wallet" onClick={() => navigate("/", { replace: true })} />
      </div>
    </div>
  )
}
