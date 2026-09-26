import type { Meta, StoryObj } from "@storybook/react-vite"
import { ProfileBackground } from "@obsidion/web-ds"

const meta = {
  title: "Backgrounds/ProfileBackground",
  component: ProfileBackground,
} satisfies Meta<typeof ProfileBackground>

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
      <ProfileBackground />
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
      <ProfileBackground>
        <div style={{ padding: 24 }}>
          <div style={{ fontSize: 20, fontWeight: 600, color: "#FDFDFD" }}>Profile</div>
          <div style={{ fontSize: 12, color: "#BFC2D7", marginTop: 4 }}>
            @cyphergirl &middot; zk.money
          </div>
        </div>
      </ProfileBackground>
    </div>
  ),
}
