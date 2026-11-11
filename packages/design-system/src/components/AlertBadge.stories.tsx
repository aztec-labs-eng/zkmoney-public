import type { Meta, StoryObj } from "@storybook/react-vite"
import { AlertBadge } from "@obsidion/web-ds"

const meta = {
  title: "Status & Feedback/AlertBadge",
  component: AlertBadge,
} satisfies Meta<typeof AlertBadge>

export default meta
type Story = StoryObj<typeof meta>

/** S1 and S2: Settings in the menu, and the Passkeys row, while the account has one passkey. */
export const NoBackup: Story = {
  args: { label: "Your account has one passkey" },
}
