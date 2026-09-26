import { useState, type ComponentProps } from "react"
import { AssetProvider } from "@obsidion/front-core"
import { OnboardingScreen, type OnboardingScreenProps } from "../onboarding/OnboardingScreen"
import { pendingTicketRegistration } from "./ticketContinuation"
import { usePaylinkKit } from "./usePaylinkDeps"

/**
 * The signup wizard with the paylink services a ticket-funded signup claims its link with. For a
 * host inside the asset layer only: that layer owns the token service and the enclave co-signer
 * the claim needs, and the ordinary wizard runs without it.
 */
export function PaylinkOnboardingScreen(props: Omit<OnboardingScreenProps, "paylinkKit">) {
  const kit = usePaylinkKit()
  return <OnboardingScreen {...props} paylinkKit={kit} />
}

/**
 * `/claim`. Ordinary onboarding renders outside the asset layer (see App's AssetGate for why). A
 * pending registration a payment link funds claims that link from its pending step, and the claim
 * needs the layer, so that one resume mounts it, as the link page hosting the same signup does.
 * Decided at mount: a ticket-funded reservation only ever starts on the link page.
 */
export function ClaimRoute({
  assetOptions,
}: {
  assetOptions: ComponentProps<typeof AssetProvider>["assetOptions"]
}) {
  const [ticketFunded] = useState(pendingTicketRegistration)
  if (!ticketFunded) return <OnboardingScreen />
  return (
    <AssetProvider assetOptions={assetOptions}>
      <PaylinkOnboardingScreen />
    </AssetProvider>
  )
}
