import type { Meta, StoryObj } from "@storybook/react-vite"
import { RadialPurpleBackground } from "@obsidion/web-ds"

const meta = {
  title: "Backgrounds/RadialPurpleBackground",
  component: RadialPurpleBackground,
} satisfies Meta<typeof RadialPurpleBackground>

export default meta
type Story = StoryObj<typeof meta>

export const TopAnchor: Story = {
  render: () => (
    <div
      style={{
        position: "relative",
        width: 320,
        height: 260,
        overflow: "hidden",
        borderRadius: 16,
      }}
    >
      <RadialPurpleBackground>
        <div
          style={{
            padding: 24,
            textAlign: "center",
            color: "#FDFDFD",
            fontSize: 18,
            fontWeight: 600,
          }}
        >
          Claim your @tag
        </div>
      </RadialPurpleBackground>
    </div>
  ),
}

export const BottomAnchor: Story = {
  args: { anchor: "bottom" },
  render: (args) => (
    <div
      style={{
        position: "relative",
        width: 320,
        height: 260,
        overflow: "hidden",
        borderRadius: 16,
      }}
    >
      <RadialPurpleBackground {...args} />
    </div>
  ),
}
