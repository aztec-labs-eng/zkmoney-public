import type { Meta, StoryObj } from "@storybook/react-vite"
import { ZkMoneyRoot } from "@obsidion/web-ds"

const meta = {
  title: "Foundations/ZkMoneyRoot",
  component: ZkMoneyRoot,
} satisfies Meta<typeof ZkMoneyRoot>

export default meta
type Story = StoryObj<typeof meta>

export const Canvas: Story = {
  args: {
    flush: false,
    style: { width: 320 },
    children: (
      <>
        <div style={{ fontSize: 16, fontWeight: 600 }}>Your balance is private</div>
        <div style={{ fontSize: 12, color: "#BFC2D7", marginTop: 4 }}>
          Only you can see your zk.money activity.
        </div>
      </>
    ),
  },
}
