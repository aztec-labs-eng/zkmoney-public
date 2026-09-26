import type { Meta, StoryObj } from "@storybook/react-vite"
import { Card, Shimmer } from "@obsidion/web-ds"

const BalanceCard = () => (
  <Card style={{ width: 280 }} padding={16}>
    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
      <span style={{ fontSize: 12, color: "#BFC2D7" }}>Total balance</span>
      <span style={{ fontSize: 28, fontWeight: 600, color: "#FDFDFD" }}>$1,284.09</span>
      <span style={{ fontSize: 12, color: "#BFC2D7" }}>@cyphergirl &middot; zk.money</span>
    </div>
  </Card>
)

const meta = {
  title: "Status & Feedback/Shimmer",
  component: Shimmer,
} satisfies Meta<typeof Shimmer>

export default meta
type Story = StoryObj<typeof meta>

export const Loading: Story = {
  args: { children: <BalanceCard /> },
}

export const Loaded: Story = {
  args: { active: false, children: <BalanceCard /> },
}
