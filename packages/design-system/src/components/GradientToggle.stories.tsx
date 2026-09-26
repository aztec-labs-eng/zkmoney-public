import type { Meta, StoryObj } from "@storybook/react-vite"
import { useState } from "react"
import { GradientToggle } from "@obsidion/web-ds"

const meta = {
  title: "Buttons/GradientToggle",
  component: GradientToggle,
} satisfies Meta<typeof GradientToggle>

export default meta
type Story = StoryObj<typeof meta>

/** Uncontrolled host so the toggle flips on tap; args.isOn seeds it. */
const InteractiveToggle = ({ isOn }: { isOn: boolean }) => {
  const [on, setOn] = useState(isOn)
  return <GradientToggle isOn={on} onChange={setOn} />
}

export const On: Story = {
  args: { isOn: true },
  render: (args) => <InteractiveToggle key={String(args.isOn)} isOn={args.isOn} />,
}

export const Off: Story = {
  args: { isOn: false },
  render: (args) => <InteractiveToggle key={String(args.isOn)} isOn={args.isOn} />,
}

export const InSettingsRow: Story = {
  args: { isOn: true },
  render: (args) => (
    <div
      style={{ display: "flex", alignItems: "center", justifyContent: "space-between", width: 300 }}
    >
      <span style={{ fontSize: 16, fontWeight: 500 }}>Face ID</span>
      <InteractiveToggle key={String(args.isOn)} isOn={args.isOn} />
    </div>
  ),
}
