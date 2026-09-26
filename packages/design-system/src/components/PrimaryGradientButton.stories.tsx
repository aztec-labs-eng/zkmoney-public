import type { Meta, StoryObj } from "@storybook/react-vite"
import { PrimaryGradientButton } from "@obsidion/web-ds"

const meta = {
  title: "Buttons/PrimaryGradientButton",
  component: PrimaryGradientButton,
} satisfies Meta<typeof PrimaryGradientButton>

export default meta
type Story = StoryObj<typeof meta>

export const Primary: Story = {
  args: { title: "Continue", trailingIcon: "arrow-right" },
}

/* Glass is invisible over a flat fill: show the secondary over the brand gradient
   plus a list of rows, side by side with the gradient primary. */
export const Dark: Story = {
  args: { title: "Keep waiting", buttonStyle: "dark" },
  render: (args) => (
    <div
      style={{
        position: "relative",
        width: 390,
        padding: 16,
        borderRadius: 16,
        overflow: "hidden",
        background: "linear-gradient(90deg, #a000ff, #0099ff)",
      }}
    >
      <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
        {[
          "Alice sent you $24.00",
          "Swap 0.5 ETH for USDC",
          "Bridge 1.2 ETH from L1",
          "Bob requested $12.50",
        ].map((t) => (
          <div
            key={t}
            style={{
              display: "flex",
              alignItems: "center",
              gap: 10,
              padding: "10px 12px",
              borderRadius: 12,
              background: "rgba(255, 255, 255, 0.16)",
            }}
          >
            <span
              style={{
                width: 26,
                height: 26,
                borderRadius: 9999,
                background: "rgba(255, 255, 255, 0.4)",
                flex: "none",
              }}
            />
            <span style={{ color: "#fff", fontFamily: "var(--font-body)", fontSize: 13 }}>{t}</span>
          </div>
        ))}
      </div>
      <div
        style={{
          position: "absolute",
          inset: 0,
          display: "flex",
          alignItems: "center",
          gap: 12,
          padding: 16,
        }}
      >
        <PrimaryGradientButton title="Continue" />
        <PrimaryGradientButton {...args} />
      </div>
    </div>
  ),
}

export const Loading: Story = {
  args: { title: "Continue", isLoading: true },
}

export const Disabled: Story = {
  args: { title: "Continue", trailingIcon: "arrow-right", isDisabled: true },
}

export const Danger: Story = {
  args: { title: "Cancel paylink", buttonStyle: "danger" },
}
