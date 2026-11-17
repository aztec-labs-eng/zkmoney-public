import type { Meta, StoryObj } from "@storybook/react-vite"
import { HoldingSelect, RatePill } from "@obsidion/web-ds"

const meta = {
  title: "Rows & Lists/HoldingSelect",
  component: HoldingSelect,
  decorators: [(Story) => <div style={{ width: 410 }}>{Story()}</div>],
} satisfies Meta<typeof HoldingSelect>

export default meta
type Story = StoryObj<typeof meta>

export const WithChange: Story = {
  args: {
    icon: (
      <span
        style={{
          display: "block",
          width: 40,
          height: 40,
          borderRadius: "50%",
          background: "#fea54e",
        }}
      />
    ),
    title: "USDS",
    rate: <RatePill size="xs" label="3.8% APY" />,
    subtitle: "Sky Savings Rate",
    changeLabel: "Change",
    onChange: () => {},
  },
}

/** One holding to choose from: no control. */
export const Only: Story = {
  args: { ...WithChange.args, onChange: undefined },
}
