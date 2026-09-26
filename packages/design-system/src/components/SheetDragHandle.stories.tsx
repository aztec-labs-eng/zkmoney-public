import type { Meta, StoryObj } from "@storybook/react-vite"
import { SheetDragHandle } from "@obsidion/web-ds"

const meta = {
  title: "Foundations/SheetDragHandle",
  component: SheetDragHandle,
} satisfies Meta<typeof SheetDragHandle>

export default meta
type Story = StoryObj<typeof meta>

const SheetTop = ({ opacity }: { opacity?: number }) => (
  <div
    style={{
      width: 320,
      background: "#212121",
      borderRadius: "24px 24px 0 0",
      padding: "8px 24px 24px",
      display: "flex",
      flexDirection: "column",
      alignItems: "center",
      gap: 20,
    }}
  >
    <SheetDragHandle opacity={opacity} />
    <span style={{ alignSelf: "flex-start", color: "#FDFDFD", fontSize: 18, fontWeight: 600 }}>
      Confirm send
    </span>
  </div>
)

export const OnSheet: Story = {
  render: () => <SheetTop />,
}

export const Prominent: Story = {
  args: { opacity: 0.5 },
  render: (args) => <SheetTop opacity={args.opacity} />,
}
