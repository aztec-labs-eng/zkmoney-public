import type { Meta, StoryObj } from "@storybook/react-vite"
import { Spinner } from "@obsidion/web-ds"

const meta = {
  title: "Status & Feedback/Spinner",
  component: Spinner,
} satisfies Meta<typeof Spinner>

export default meta
type Story = StoryObj<typeof meta>

export const PendingRow: Story = {
  args: { size: 12 },
  render: (args) => (
    <div style={{ display: "flex", alignItems: "center", gap: 6, color: "#BFC2D7", fontSize: 12 }}>
      <Spinner {...args} />
      <span>Pending</span>
    </div>
  ),
}

export const Proving: Story = {
  args: { size: 20, color: "#A000FF" },
  render: (args) => (
    <div style={{ display: "flex", alignItems: "center", gap: 10, color: "#FDFDFD", fontSize: 14 }}>
      <Spinner {...args} />
      <span>Keeping it private…</span>
    </div>
  ),
}

export const BalanceRefresh: Story = {
  render: () => (
    <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
      <span style={{ fontSize: 24, fontWeight: 600, color: "#FDFDFD" }}>$1,284.09</span>
      <Spinner />
    </div>
  ),
}
