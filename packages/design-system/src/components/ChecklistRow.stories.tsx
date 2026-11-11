import type { Meta, StoryObj } from "@storybook/react-vite"
import { ChecklistRow, SheetCard } from "@obsidion/web-ds"

const meta = {
  title: "Sheets & Modals/ChecklistRow",
  component: ChecklistRow,
  decorators: [
    (Story) => (
      <div
        style={{ width: 372, padding: 24, borderRadius: 24, background: "var(--surface-sheet)" }}
      >
        <SheetCard>{Story()}</SheetCard>
      </div>
    ),
  ],
} satisfies Meta<typeof ChecklistRow>

export default meta
type Story = StoryObj<typeof meta>

export const ToDo: Story = {
  args: {
    done: false,
    label: "Close your 2 open paylinks",
    detail: "Once you add a backup, you can't cancel or take back older links.",
    action: { label: "Review", onClick: () => {} },
  },
}

export const DoneAndMuted: Story = {
  args: { done: true, muted: true, label: "Account registered", detail: "Done" },
}

/** B4 lists the two passkeys the same way, unmuted. */
export const SignedInNow: Story = {
  args: { done: true, label: "Backup passkey", detail: "Your phone · signed in now" },
}

export const Checklist: Story = {
  args: ToDo.args,
  render: () => (
    <>
      <ChecklistRow done muted label="Account registered" detail="Done" />
      <ChecklistRow
        done={false}
        label="Finish your withdrawal"
        detail="$40.00 to Base is on its way. About 20 min."
        action={{ label: "View", onClick: () => {} }}
      />
      <ChecklistRow {...ToDo.args} />
      <ChecklistRow
        done={false}
        label="Have at least $1.30"
        detail="You have $0.90."
        action={{ label: "Deposit", onClick: () => {} }}
      />
    </>
  ),
}
