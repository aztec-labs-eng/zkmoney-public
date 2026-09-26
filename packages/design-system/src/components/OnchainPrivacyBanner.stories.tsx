import type { Meta, StoryObj } from "@storybook/react-vite"
import { OnchainPrivacyBanner } from "@obsidion/web-ds"

const meta = {
  title: "Banners/OnchainPrivacyBanner",
  component: OnchainPrivacyBanner,
  decorators: [(Story) => <div style={{ width: 360 }}>{Story()}</div>],
} satisfies Meta<typeof OnchainPrivacyBanner>

export default meta
type Story = StoryObj<typeof meta>

export const Default: Story = {}

export const PaylinkCopy: Story = {
  args: {
    title: "Unlinkable by design",
    body: "Each payment link spends from a fresh note. Claimers never learn your balance or history.",
  },
}
