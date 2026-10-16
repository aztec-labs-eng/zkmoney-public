import { useNavigate } from "react-router-dom"
import { InvitationChrome } from "../../features/onboarding/InvitationChrome"

/** Catch-all for unknown routes. Mounted outside AccountGate so it never waits on PXE boot. */
export function NotFoundScreen() {
  const navigate = useNavigate()
  return (
    <InvitationChrome pill={false}>
      <div className="ww-invite__content" data-testid="not-found">
        <span className="ww-invite__pill">ERROR 404</span>
        <h1 className="ww-invite__title" style={{ marginTop: 20 }}>
          Page not found
        </h1>
        <p className="ww-invite__subtitle">
          The page you&rsquo;re looking for doesn&rsquo;t exist or has moved.
        </p>
        <button
          type="button"
          className="ww-invite__unlock"
          onClick={() => navigate("/", { replace: true })}
        >
          Go to wallet
        </button>
      </div>
    </InvitationChrome>
  )
}
