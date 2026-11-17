import type { Meta, StoryObj } from "@storybook/react-vite"
import { FactBox, HoldingRow, RatePill } from "@obsidion/web-ds"

const meta = {
  title: "Sheets & Modals/FactBox",
  component: FactBox,
  decorators: [
    (Story) => (
      <div
        style={{
          width: 372,
          padding: 24,
          borderRadius: 24,
          background: "var(--surface-sheet)",
          minHeight: 200,
        }}
      >
        {Story()}
      </div>
    ),
  ],
} satisfies Meta<typeof FactBox>

export default meta
type Story = StoryObj<typeof meta>

/** Hover or tap the info icon beside Cost for the breakdown. */
export const CostAndTime: Story = {
  args: {
    facts: [
      {
        label: "Cost",
        value: "About $0.70",
        hint: {
          label: "How the cost adds up",
          title: "How the cost adds up",
          rows: [
            { label: "Account update", value: "$0.70" },
            { label: "Network fee", value: "Varies" },
          ],
          note: "You'll see the exact amount before you pay.",
        },
      },
      { label: "Time", value: "Up to 45 min" },
    ],
  },
}

export const ChargedNothing: Story = {
  args: { facts: [{ label: "Charged", value: "Nothing" }] },
}

export const CantCancel: Story = {
  args: { facts: [{ label: "Can I cancel?", value: "Not after paying" }] },
}

/** A holding over facts that read as sentences. */
export const HoldingFacts: Story = {
  args: {
    layout: "columns",
    head: (
      <HoldingRow
        icon={
          <span
            style={{
              display: "block",
              width: 40,
              height: 40,
              borderRadius: "50%",
              background: "#fea54e",
            }}
          />
        }
        title="USDS"
        subtitle="Sky Savings Rate"
        value="$550.00"
        rate={<RatePill size="sm" label="3.8% APY" />}
      />
    ),
    facts: [
      { label: "Yield from", value: "Sky Savings Rate, set by Sky governance" },
      { label: "Move back", value: "Any time · about 40 min" },
      { label: "Risk", value: "Low · backed 1:1 by dollar assets" },
    ],
  },
}
