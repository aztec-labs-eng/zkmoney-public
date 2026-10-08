import type { Meta, StoryObj } from "@storybook/react-vite"
import { useState } from "react"
import { AmountChipRow, type AmountChipRowProps } from "@obsidion/web-ds"

const meta = {
  title: "Payments/AmountChipRow",
  component: AmountChipRow,
  decorators: [(Story) => <div style={{ width: 360 }}>{Story()}</div>],
} satisfies Meta<typeof AmountChipRow>

export default meta
type Story = StoryObj<typeof meta>

/** Uncontrolled host so tapping a chip selects it; args.selectedValue seeds it. */
const InteractiveChips = (props: AmountChipRowProps) => {
  const [selected, setSelected] = useState(props.selectedValue)
  return <AmountChipRow {...props} selectedValue={selected} onSelect={setSelected} />
}

export const Glass: Story = {
  args: { values: [10, 25, 50, 100], selectedValue: 25 },
  render: (args) => <InteractiveChips key={args.selectedValue} {...args} />,
}

export const Flat: Story = {
  args: { values: [10, 25, 50, 100], glass: false },
  render: (args) => <InteractiveChips key={args.selectedValue} {...args} />,
}

/** A live minimum puts the smallest chip out of reach; it stays visible so the row keeps its shape. */
export const WithDisabled: Story = {
  args: { values: [1, 5, 10, 15], selectedValue: 5, disabledValues: [1], glass: false },
  render: (args) => <InteractiveChips key={args.selectedValue} {...args} />,
}
