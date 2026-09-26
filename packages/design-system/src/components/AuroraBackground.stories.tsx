import type { Meta, StoryObj } from "@storybook/react-vite"
import { AuroraBackground } from "@obsidion/web-ds"

const meta = {
  title: "Backgrounds/AuroraBackground",
  component: AuroraBackground,
} satisfies Meta<typeof AuroraBackground>

export default meta
type Story = StoryObj<typeof meta>

export const HomeCanvas: Story = {
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
      <AuroraBackground />
    </div>
  ),
}

export const WithContent: Story = {
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
      <AuroraBackground>
        <div style={{ padding: 24 }}>
          <div style={{ fontSize: 12, color: "#BFC2D7" }}>Total balance</div>
          <div style={{ fontSize: 32, fontWeight: 600, color: "#FDFDFD" }}>$1,284.09</div>
        </div>
      </AuroraBackground>
    </div>
  ),
}
