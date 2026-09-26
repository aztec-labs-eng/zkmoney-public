import type { Meta, StoryObj } from "@storybook/react-vite"
import { Card, IconCircle, RowChevron } from "@obsidion/web-ds"

const meta = {
  title: "Foundations/RowChevron",
  component: RowChevron,
} satisfies Meta<typeof RowChevron>

export default meta
type Story = StoryObj<typeof meta>

export const SettingsRow: Story = {
  render: () => (
    <Card style={{ width: 300 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
        <IconCircle name="lock-shield" />
        <span style={{ flex: 1, fontSize: 16, fontWeight: 500 }}>Security</span>
        <RowChevron />
      </div>
    </Card>
  ),
}

export const PlainRow: Story = {
  render: () => (
    <div style={{ display: "flex", alignItems: "center", gap: 12, width: 280 }}>
      <span style={{ flex: 1, fontSize: 14, color: "#BFC2D7" }}>View all activity</span>
      <RowChevron />
    </div>
  ),
}
