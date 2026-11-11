import { FactBox, InfoBox, NextStepsDisclosure, SheetShell } from "@obsidion/web-ds"
import type { Fact } from "@obsidion/web-ds"
import { fmt } from "../../../../lib/fmt"
import { usdAtomic } from "../../../../ui/format"
import type { BackupScreenProps } from "../../backupScreen"
import copy from "./IntroScreen.copy"

/** A2: what the add costs and takes, before the first passkey prompt. */
export function IntroScreen({ screen, actions }: BackupScreenProps<"intro">) {
  const { quote, picker, links, busy } = screen
  const minutes = quote && Math.ceil(quote.takesMs / 60_000)
  const facts: Fact[] =
    quote && minutes !== undefined
      ? [
          {
            label: copy.cost,
            value: fmt(copy.costValue, { amount: usdAtomic(quote.total) }),
            hint: {
              label: copy.costHint.title,
              title: copy.costHint.title,
              rows: [
                { label: copy.costHint.fixed, value: usdAtomic(quote.fixed) },
                { label: copy.costHint.network, value: usdAtomic(quote.network) },
              ],
              note: copy.costHint.note,
            },
          },
          { label: copy.time, value: fmt(copy.timeValue, { minutes }) },
        ]
      : []
  return (
    <SheetShell
      hero="key"
      title={copy.title}
      lead={copy.lead}
      primary={{
        label: copy.continue,
        onClick: () => (picker ? actions.start("place") : actions.add()),
        loading: busy,
        testId: "backup-continue",
      }}
    >
      {facts.length > 0 && <FactBox facts={facts} />}
      <NextStepsDisclosure
        title={copy.next}
        steps={[
          { label: copy.steps.save, detail: picker ? copy.steps.saveWhere : copy.steps.saveHere },
          { label: copy.steps.approve, detail: copy.steps.approveDetail },
          {
            label: copy.steps.wait,
            detail:
              minutes !== undefined ? fmt(copy.steps.waitFor, { minutes }) : copy.steps.waitDetail,
          },
          { label: copy.steps.finish, detail: copy.steps.finishDetail },
        ]}
      />
      {links > 0 && (
        <InfoBox title={links === 1 ? copy.links.one : fmt(copy.links.many, { count: links })}>
          {links === 1 ? copy.links.oneDetail : copy.links.manyDetail}
        </InfoBox>
      )}
    </SheetShell>
  )
}
