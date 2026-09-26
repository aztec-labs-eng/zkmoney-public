import type { Meta, StoryObj } from "@storybook/react-vite"
import { StatusPill } from "@obsidion/web-ds"

const meta = {
  title: "Status & Feedback/StatusPill",
  component: StatusPill,
} satisfies Meta<typeof StatusPill>

export default meta
type Story = StoryObj<typeof meta>

export const Successful: Story = {
  args: { label: "Successful", icon: "check-circle", iconColor: "#56E79D" },
}

export const Unclaimed: Story = {
  args: { label: "Unclaimed", icon: "clock", iconColor: "#EED04E" },
}

export const YouOwe: Story = {
  args: { label: "You owe", icon: "alert-circle", labelColor: "#FE708B", iconColor: "#FE708B" },
}

export const Unverified: Story = {
  args: { label: "Unverified" },
}
