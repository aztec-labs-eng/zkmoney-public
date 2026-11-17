import type { Meta, StoryObj } from "@storybook/react-vite"
import { ComingSoonPill, HoldingRow, RatePill, SkeletonBlock } from "@obsidion/web-ds"

const coin = (color: string) => (
  <span
    style={{ display: "block", width: 40, height: 40, borderRadius: "50%", background: color }}
  />
)

const meta = {
  title: "Rows & Lists/HoldingRow",
  component: HoldingRow,
  decorators: [(Story) => <div style={{ width: 452 }}>{Story()}</div>],
} satisfies Meta<typeof HoldingRow>

export default meta
type Story = StoryObj<typeof meta>

export const Funded: Story = {
  args: {
    icon: coin("#fea54e"),
    title: "USDS",
    subtitle: "Sky Savings Rate",
    value: "$550.00",
    rate: <RatePill size="sm" label="3.8% APY" />,
  },
}

export const New: Story = {
  args: {
    icon: coin("#2775ca"),
    title: "USDC",
    badge: <ComingSoonPill size="sm" label="New" />,
    subtitle: "Steakhouse Prime on Morpho",
    value: "$0.00",
    rate: <RatePill size="sm" label="5.1% APY" />,
  },
}

/** A row that opens the holding: a button ending in a chevron. */
export const Clickable: Story = {
  args: { ...Funded.args, onClick: () => {} },
}

export const NoRate: Story = {
  args: { icon: coin("#2775ca"), title: "USDC", subtitle: "Move out only", value: "$315.00" },
}

export const Loading: Story = {
  args: {
    icon: <SkeletonBlock width={40} height={40} radius={20} />,
    title: <SkeletonBlock width={48} height={14} />,
    subtitle: <SkeletonBlock width={110} height={12} />,
    value: <SkeletonBlock width={56} height={14} />,
  },
}
