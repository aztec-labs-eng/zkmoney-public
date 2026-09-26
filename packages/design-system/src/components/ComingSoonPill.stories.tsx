import type { Meta, StoryObj } from "@storybook/react-vite"
import { ComingSoonPill, ListRow } from "@obsidion/web-ds"

const meta = {
  title: "Status & Feedback/ComingSoonPill",
  component: ComingSoonPill,
} satisfies Meta<typeof ComingSoonPill>

export default meta
type Story = StoryObj<typeof meta>

export const Default: Story = {}

export const OnPaymentMethodRow: Story = {
  render: () => (
    <div style={{ width: 320 }}>
      <ListRow
        title="Apple Pay"
        subtitle="Top up instantly with Apple Pay"
        disabled
        floatingTrailing
        trailing={<ComingSoonPill />}
      />
    </div>
  ),
}

export const CustomLabel: Story = {
  args: { label: "Soon" },
}
