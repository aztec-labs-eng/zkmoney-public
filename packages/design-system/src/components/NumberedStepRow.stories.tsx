import type { Meta, StoryObj } from "@storybook/react-vite"
import { Card, NumberedStepRow } from "@obsidion/web-ds"

const meta = {
  title: "Onboarding/NumberedStepRow",
  component: NumberedStepRow,
} satisfies Meta<typeof NumberedStepRow>

export default meta
type Story = StoryObj<typeof meta>

export const HowItWorks: Story = {
  args: { children: null },
  render: () => (
    <Card radius={16} padding={16} style={{ width: 354, display: "flex", flexDirection: "column", gap: 16 }}>
      <NumberedStepRow icon="person">
        Your X handle becomes your zk.money @tag, claim it now and join the waitlist.
      </NumberedStepRow>
      <NumberedStepRow icon="at">
        Your @tag is your payment address, use it to send and receive private payments.
      </NumberedStepRow>
      <NumberedStepRow icon="gift">
        Refer friends to unlock priority access and other rewards when zk.money launches.
      </NumberedStepRow>
    </Card>
  ),
}

export const NumberedList: Story = {
  args: { children: null },
  render: () => (
    <Card radius={16} padding={16} style={{ width: 354, display: "flex", flexDirection: "column", gap: 16 }}>
      <NumberedStepRow index={1}>Visit our launch post on X</NumberedStepRow>
      <NumberedStepRow index={2}>Comment to claim with your X handle</NumberedStepRow>
      <NumberedStepRow index={3}>Verify ownership and claim your @tag</NumberedStepRow>
    </Card>
  ),
}
