import type { Meta, StoryObj } from "@storybook/react-vite"
import { PurpleBlueGradientBackground } from "@obsidion/web-ds"

const meta = {
  title: "Backgrounds/PurpleBlueGradientBackground",
  component: PurpleBlueGradientBackground,
} satisfies Meta<typeof PurpleBlueGradientBackground>

export default meta
type Story = StoryObj<typeof meta>

export const Default: Story = {
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
      <PurpleBlueGradientBackground />
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
      <PurpleBlueGradientBackground>
        <div style={{ padding: 24, color: "#FDFDFD", fontSize: 18, fontWeight: 600 }}>
          Welcome to zk.money
        </div>
      </PurpleBlueGradientBackground>
    </div>
  ),
}
