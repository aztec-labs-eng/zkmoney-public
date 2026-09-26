import type { Meta, StoryObj } from "@storybook/react-vite"
import { CopyableLinkRow } from "@obsidion/web-ds"

const meta = {
  title: "Rows & Lists/CopyableLinkRow",
  component: CopyableLinkRow,
} satisfies Meta<typeof CopyableLinkRow>

export default meta
type Story = StoryObj<typeof meta>

export const Default: Story = {
  args: {
    url: "https://paylink.test.zk.money/request#abc123",
    onCopy: () => {},
  },
}

export const Copied: Story = {
  args: {
    url: "https://paylink.test.zk.money/request#abc123",
    copied: true,
    onCopy: () => {},
  },
}
