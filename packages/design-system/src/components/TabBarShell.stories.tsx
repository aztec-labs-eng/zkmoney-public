import type { Meta, StoryObj } from "@storybook/react-vite"
import { useState } from "react"
import { TabBarShell, type TabBarProps } from "@obsidion/web-ds"

const tabs = [
  { name: "home", label: "Home", icon: "home" },
  { name: "payments", label: "Payments", icon: "payments-arrows" },
  { name: "activity", label: "Activity", icon: "history-clock" },
  { name: "profile", label: "Profile", icon: "person" },
]

const meta = {
  title: "Navigation/TabBarShell",
  component: TabBarShell,
  decorators: [(Story) => <div style={{ width: 390 }}>{Story()}</div>],
} satisfies Meta<typeof TabBarShell>

export default meta
type Story = StoryObj<typeof meta>

/** Uncontrolled host so tapping tabs slides the glass indicator; args.activeTab seeds it. */
const InteractiveShell = (props: TabBarProps) => {
  const [active, setActive] = useState(props.activeTab)
  return <TabBarShell {...props} activeTab={active} onTabChange={setActive} />
}

export const HomeActive: Story = {
  args: { tabs, activeTab: "home" },
  render: (args) => <InteractiveShell key={args.activeTab} {...args} />,
}

export const ProfileActive: Story = {
  args: { tabs, activeTab: "profile" },
  render: (args) => <InteractiveShell key={args.activeTab} {...args} />,
}
