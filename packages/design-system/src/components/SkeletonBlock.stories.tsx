import type { Meta, StoryObj } from "@storybook/react-vite"
import { Shimmer, SkeletonBlock } from "@obsidion/web-ds"

const meta = {
  title: "Status & Feedback/SkeletonBlock",
  component: SkeletonBlock,
  decorators: [(Story) => <Shimmer style={{ width: "fit-content" }}>{Story()}</Shimmer>],
} satisfies Meta<typeof SkeletonBlock>

export default meta
type Story = StoryObj<typeof meta>

export const Line: Story = { args: { width: 130, height: 14 } }

export const Circle: Story = { args: { width: 44, height: 44, radius: 22 } }
