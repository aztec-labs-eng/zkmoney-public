import { FactBox, InfoBox, NextSteps, SheetShell, TopNavIconButton } from "@obsidion/web-ds"
import type { Fact } from "@obsidion/web-ds"
import { fmt } from "../../../../lib/fmt"
import { usdFromCents } from "../../../../ui/format"
import { addCost, feeSplit } from "../../backupCost"
import { holdCopy } from "../../backupPasskeyCopy"
import type { BackupScreenProps, IntroCost } from "../../backupScreen"
import copy from "./IntroScreen.copy"

/** The fee, its breakdown, and the hold that comes back. */
function costFacts({ funding, fixed }: IntroCost): Fact[] {
  const { fee, hold } = addCost(funding)
  // The network part carries Faster's tip.
  const [network, fixedCents] = feeSplit(fee, fixed)
  return [
    {
      label: copy.cost,
      value: fmt(copy.costValue, { amount: usdFromCents(fee) }),
      hint: {
        label: copy.costHint.title,
        title: copy.costHint.title,
        rows: [
          { label: copy.costHint.fixed, value: usdFromCents(fixedCents) },
          { label: copy.costHint.network, value: usdFromCents(network) },
        ],
        note: copy.costHint.note,
        // Below, it would cover the Time row and the first step.
        above: true,
      },
    },
    { label: holdCopy.label, value: fmt(holdCopy.value, { amount: usdFromCents(hold) }) },
  ]
}

/** A2: what the add costs and takes, before the first passkey prompt. */
export function IntroScreen({ screen, actions }: BackupScreenProps<"intro">) {
  const { cost, eta, picker, links, busy } = screen
  const minutes = eta === undefined ? undefined : Math.ceil(eta / 60)
  const facts: Fact[] = [
    ...(cost ? costFacts(cost) : []),
    ...(minutes === undefined
      ? []
      : [{ label: copy.time, value: fmt(copy.timeValue, { minutes }) }]),
  ]
  return (
    <>
      {/* The card's own back slot, beside its close button. */}
      <div className="ww-modal__back">
        <TopNavIconButton
          icon="chevron-left"
          ariaLabel={copy.back}
          onClick={() => actions.start()}
          disabled={busy}
          testId="backup-back"
        />
      </div>
      <SheetShell
        hero="key"
        title={copy.title}
        lead={copy.lead}
        primary={{
          label: picker ? copy.choose : copy.continue,
          onClick: () => (picker ? actions.start("place") : actions.add()),
          loading: busy,
          testId: "backup-continue",
        }}
      >
        {facts.length > 0 && <FactBox facts={facts} />}
        {/* Above the steps, so it shows without scrolling. */}
        {links > 0 && (
          <InfoBox title={links === 1 ? copy.links.one : fmt(copy.links.many, { count: links })}>
            {links === 1 ? copy.links.oneDetail : copy.links.manyDetail}
          </InfoBox>
        )}
        <NextSteps
          title={copy.next}
          steps={[
            { label: copy.steps.save, detail: picker ? copy.steps.saveWhere : copy.steps.saveHere },
            { label: copy.steps.approve, detail: copy.steps.approveDetail },
            {
              label: copy.steps.wait,
              detail:
                minutes !== undefined
                  ? fmt(copy.steps.waitFor, { minutes })
                  : copy.steps.waitDetail,
            },
            { label: copy.steps.finish, detail: copy.steps.finishDetail },
          ]}
        />
      </SheetShell>
    </>
  )
}
