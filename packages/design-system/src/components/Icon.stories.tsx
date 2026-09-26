import type { Meta, StoryObj } from "@storybook/react-vite"
import { Icon } from "@obsidion/web-ds"

const meta = {
  title: "Foundations/Icon",
  component: Icon,
  args: { name: "send" },
} satisfies Meta<typeof Icon>

export default meta
type Story = StoryObj<typeof meta>

const NAMES = [
  "send",
  "receive",
  "scan",
  "qr-code",
  "wallet",
  "bank",
  "link",
  "plus",
  "search",
  "bell",
  "lock",
  "key",
  "person",
  "chat-bubble",
  "check-circle",
  "alert-triangle",
  "clock",
  "copy",
  "share",
  "trash",
]

export const Glyphs: Story = {
  render: () => (
    <div style={{ display: "flex", flexWrap: "wrap", gap: 16, width: 380 }}>
      {NAMES.map((n) => (
        <div
          key={n}
          style={{
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            gap: 4,
            width: 56,
          }}
        >
          <Icon name={n} size={20} color="#fff" />
          <span style={{ fontSize: 10, color: "#BFC2D7" }}>{n}</span>
        </div>
      ))}
    </div>
  ),
}

export const AccentColors: Story = {
  render: () => (
    <div style={{ display: "flex", alignItems: "center", gap: 16 }}>
      <Icon name="check-circle" size={20} color="#56E79D" />
      <Icon name="clock" size={20} color="#EED04E" />
      <Icon name="alert-triangle" size={20} color="#F5A524" />
      <Icon name="x-octagon" size={20} color="#FE708B" />
    </div>
  ),
}
