import type { Meta, StoryObj } from "@storybook/react-vite"
import { FactBox } from "@obsidion/web-ds"

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
