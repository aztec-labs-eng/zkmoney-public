import { createRoot } from "react-dom/client"
import "../../../design-system/src/styles/styles.css"
import "../../src/ui/shell.css"
import { ChooseTagStep } from "../../src/features/onboarding/steps/ChooseTagStep/ChooseTagStep"

const noop = () => {}
createRoot(document.getElementById("root")!).render(
  <ChooseTagStep
    ticket={{ amount: 25n * 10n ** 18n, tokenDecimals: 18, tokenSymbol: "DAI" }}
    split={<p>Network fee</p>}
    tagField={{
      typed: "river",
      handle: "river",
      status: "available",
      checking: false,
      grantValid: false,
      grantBound: false,
    }}
    onType={noop}
    busy={false}
    onClaim={noop}
    onLogIn={noop}
    onCancel={noop}
    onClose={noop}
  />,
)
