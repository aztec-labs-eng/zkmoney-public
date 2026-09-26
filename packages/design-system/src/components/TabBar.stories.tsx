import type { Meta, StoryObj } from "@storybook/react-vite"
import type { CSSProperties } from "react"
import { useState } from "react"
import { TabBar, type TabBarProps } from "@obsidion/web-ds"

const tabs = [
  { name: "home", label: "Home", icon: "home" },
  { name: "payments", label: "Payments", icon: "payments-arrows" },
  { name: "activity", label: "Activity", icon: "history-clock" },
  { name: "profile", label: "Profile", icon: "person" },
]

const meta = {
  title: "Navigation/TabBar",
  component: TabBar,
  decorators: [(Story) => <div style={{ width: 360 }}>{Story()}</div>],
} satisfies Meta<typeof TabBar>

export default meta
type Story = StoryObj<typeof meta>

/** Uncontrolled host so tapping tabs slides the glass indicator; args.activeTab seeds it. */
const InteractiveTabBar = (props: TabBarProps) => {
  const [active, setActive] = useState(props.activeTab)
  return <TabBar {...props} activeTab={active} onTabChange={setActive} />
}

export const HomeActive: Story = {
  args: { tabs, activeTab: "home" },
  render: (args) => <InteractiveTabBar key={args.activeTab} {...args} />,
}

export const ActivityActive: Story = {
  args: { tabs, activeTab: "activity" },
  render: (args) => <InteractiveTabBar key={args.activeTab} {...args} />,
}

const blob = (style: CSSProperties) => (
  <span
    style={{
      position: "absolute",
      borderRadius: 9999,
      filter: "blur(40px)",
      opacity: 0.55,
      pointerEvents: "none",
      ...style,
    }}
  />
)

/** Brand aurora behind the bar so the liquid-glass refraction is visible. */
export const OverAurora: Story = {
  args: { tabs, activeTab: "home" },
  render: (args) => (
    <div
      style={{
        position: "relative",
        width: 360,
        borderRadius: 16,
        overflow: "hidden",
        background: "#141414",
        padding: "56px 10px 12px",
      }}
    >
      {blob({ width: 180, height: 180, left: -30, top: -60, background: "#a000ff" })}
      {blob({ width: 160, height: 160, right: -30, top: -20, background: "#0099ff" })}
      {blob({ width: 140, height: 140, left: 120, top: 36, background: "#FE708B" })}
      <div style={{ position: "relative" }}>
        <InteractiveTabBar key={args.activeTab} {...args} />
      </div>
    </div>
  ),
}
