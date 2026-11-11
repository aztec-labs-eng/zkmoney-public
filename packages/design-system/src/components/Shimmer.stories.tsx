import type { Meta, StoryObj } from "@storybook/react-vite"
import { Card, Shimmer, SkeletonBlock } from "@obsidion/web-ds"

const BalanceCard = () => (
  <Card style={{ width: 280 }} padding={16}>
    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
      <span style={{ fontSize: 12, color: "#BFC2D7" }}>Total balance</span>
      <SkeletonBlock width={160} height={32} radius={10} />
      <SkeletonBlock width={120} height={12} />
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

export const Still: Story = {
  args: { active: false, children: <BalanceCard /> },
}
