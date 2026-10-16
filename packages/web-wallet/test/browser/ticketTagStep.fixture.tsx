import { createRoot } from "react-dom/client"
import "../../../design-system/src/styles/styles.css"
import "../../src/ui/shell.css"
import { ChooseTagStep } from "../../src/features/onboarding/steps/ChooseTagStep"

const noop = () => {}
createRoot(document.getElementById("root")!).render(
  <ChooseTagStep
    ticket={{ amount: 25n * 10n ** 18n, tokenDecimals: 18, tokenSymbol: "DAI" }}
    split={<p>Network fee</p>}
    initialHandle="river"
    busy={false}
    onClaim={noop}
    onLogIn={noop}
    onCancel={noop}
    onClose={noop}
  />,
)
