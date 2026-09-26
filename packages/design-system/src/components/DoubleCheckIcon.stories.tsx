import type { Meta, StoryObj } from "@storybook/react-vite"
import { DoubleCheckIcon } from "@obsidion/web-ds"

const meta = {
  title: "Status & Feedback/DoubleCheckIcon",
  component: DoubleCheckIcon,
} satisfies Meta<typeof DoubleCheckIcon>

export default meta
type Story = StoryObj<typeof meta>

export const DeliveredTimestamp: Story = {
  render: () => (
    <div style={{ display: "flex", alignItems: "center", gap: 4, color: "#BFC2D7", fontSize: 12 }}>
      <span>11:15</span>
      <DoubleCheckIcon />
    </div>
  ),
}

export const SettledAmount: Story = {
  args: { size: 16 },
  render: (args) => (
    <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
      <span style={{ fontSize: 16, fontWeight: 600, color: "#56E79D" }}>+$25.23</span>
      <DoubleCheckIcon {...args} />
    </div>
  ),
}

export const Muted: Story = {
  args: { color: "#BFC2D7" },
  render: (args) => (
    <div style={{ display: "flex", alignItems: "center", gap: 4, color: "#BFC2D7", fontSize: 12 }}>
      <span>Sent 09:41</span>
      <DoubleCheckIcon {...args} />
    </div>
  ),
}
