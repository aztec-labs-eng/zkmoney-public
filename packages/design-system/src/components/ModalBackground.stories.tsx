import type { Meta, StoryObj } from "@storybook/react-vite"
import { ModalBackground } from "@obsidion/web-ds"

const meta = {
  title: "Backgrounds/ModalBackground",
  component: ModalBackground,
} satisfies Meta<typeof ModalBackground>

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
      <ModalBackground />
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
      <ModalBackground>
        <div style={{ padding: 24, color: "#FDFDFD", fontSize: 18, fontWeight: 600 }}>
          New payment
        </div>
      </ModalBackground>
    </div>
  ),
}
