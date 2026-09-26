import type { Meta, StoryObj } from "@storybook/react-vite"
import { ConfirmationSheetDetailRow } from "@obsidion/web-ds"

const meta = {
  title: "Sheets & Modals/ConfirmationSheetDetailRow",
  component: ConfirmationSheetDetailRow,
  decorators: [(Story) => <div style={{ width: 360 }}>{Story()}</div>],
} satisfies Meta<typeof ConfirmationSheetDetailRow>

export default meta
type Story = StoryObj<typeof meta>

export const FeeBreakdown: Story = {
  args: { label: "Fee", value: "$0.02" },
  render: (args) => (
    <>
      <ConfirmationSheetDetailRow {...args} />
      <ConfirmationSheetDetailRow label="Total" value="$25.02" />
      <ConfirmationSheetDetailRow label="Time" value="~30s" />
    </>
  ),
}

export const NetworkRow: Story = {
  args: { label: "Network", value: "Aztec mainnet" },
}

export const LongValue: Story = {
  args: { label: "Recipient", value: "0x84f3c1b29a77e04d5fbb61a2c83fd09c21aa40be" },
}
