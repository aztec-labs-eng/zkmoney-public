import type { Meta, StoryObj } from "@storybook/react-vite"
import { NudgeCard } from "@obsidion/web-ds"

const meta = {
  title: "Banners/NudgeCard",
  component: NudgeCard,
  decorators: [(Story) => <div style={{ width: 354 }}>{Story()}</div>],
} satisfies Meta<typeof NudgeCard>

export default meta
type Story = StoryObj<typeof meta>

/** H1 and S1: one passkey and enough funds to lose. */
export const ProtectAccount: Story = {
  args: {
    title: "Protect your account",
    body: "Add a second passkey on another device so you can always recover your funds.",
    action: { label: "Add backup passkey", onClick: () => {} },
    onDismiss: () => {},
  },
}

/** H3: a backup halfway done can't be put off, so there is no x. */
export const FinishBackup: Story = {
  args: {
    title: "Finish backing up your account",
    body: "To finish backing up, you need to approve one more time.",
    action: { label: "Approve", onClick: () => {} },
  },
}
