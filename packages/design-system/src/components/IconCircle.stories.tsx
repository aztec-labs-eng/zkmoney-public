import type { Meta, StoryObj } from "@storybook/react-vite"
import { IconCircle } from "@obsidion/web-ds"

const meta = {
  title: "Foundations/IconCircle",
  component: IconCircle,
} satisfies Meta<typeof IconCircle>

export default meta
type Story = StoryObj<typeof meta>

export const Default: Story = {
  args: { name: "wallet" },
}

export const SettingsRowIcons: Story = {
  args: { name: "person-circle" },
  render: () => (
    <div style={{ display: "flex", gap: 12 }}>
      <IconCircle name="person-circle" />
      <IconCircle name="lock-shield" />
      <IconCircle name="bell" />
    </div>
  ),
}

export const Large: Story = {
  args: { name: "qr-code", size: 56, glyphSize: 22 },
}
