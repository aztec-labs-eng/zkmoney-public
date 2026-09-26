import type { Meta, StoryObj } from "@storybook/react-vite"
import { GradientSpinner } from "@obsidion/web-ds"

const meta = {
  title: "Status & Feedback/GradientSpinner",
  component: GradientSpinner,
} satisfies Meta<typeof GradientSpinner>

export default meta
type Story = StoryObj<typeof meta>

export const Default: Story = {
  args: { size: 40 },
}

export const ModalBusy: Story = {
  args: { size: 40 },
  render: (args) => (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        gap: 16,
        color: "#FDFDFD",
        fontSize: 14,
      }}
    >
      <GradientSpinner {...args} />
      <span>Creating account with passkey...</span>
    </div>
  ),
}
