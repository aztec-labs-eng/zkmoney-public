import type { Meta, StoryObj } from "@storybook/react-vite"
import { ProgressSpinner } from "@obsidion/web-ds"

const meta = {
  title: "Status & Feedback/ProgressSpinner",
  component: ProgressSpinner,
} satisfies Meta<typeof ProgressSpinner>

export default meta
type Story = StoryObj<typeof meta>

export const SyncingDeposits: Story = {
  args: { progress: 0.43, size: 12, color: "#FDFDFD" },
  render: (args) => (
    <div style={{ display: "flex", alignItems: "center", gap: 6, color: "#FDFDFD", fontSize: 12 }}>
      <ProgressSpinner {...args} />
      <span>Syncing deposits - {Math.round(args.progress * 100)}%</span>
    </div>
  ),
}
