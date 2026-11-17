import type { Meta, StoryObj } from "@storybook/react-vite"
import { RatePill } from "@obsidion/web-ds"

const meta = {
  title: "Status & Feedback/RatePill",
  component: RatePill,
  args: { label: "3.8% APY" },
} satisfies Meta<typeof RatePill>

export default meta
type Story = StoryObj<typeof meta>

export const Default: Story = {}

export const Small: Story = { args: { size: "sm" } }

/** Dotless, beside a title. */
export const Inline: Story = { args: { size: "xs" } }
