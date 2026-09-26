import type { Meta, StoryObj } from "@storybook/react-vite"
import { GradientHeroCard, GradientInitialAvatar, Icon } from "@obsidion/web-ds"

const meta = {
  title: "Onboarding/GradientHeroCard",
  component: GradientHeroCard,
} satisfies Meta<typeof GradientHeroCard>

export default meta
type Story = StoryObj<typeof meta>

export const ClaimAvailable: Story = {
  args: {
    style: { width: 354 },
    avatar: <GradientInitialAvatar name="prvmoney" size={80} />,
    title: (
      <>
        @prvmoney
        <br />
        is yours to claim
      </>
    ),
    subtitle: "Sign in with X to claim your zk.money tag and join the waitlist for private payments.",
    footer: (
      <>
        <Icon name="lock" size={12} />
        reserved
      </>
    ),
  },
}

export const NoFooter: Story = {
  args: {
    style: { width: 354 },
    title: "Stay in the loop",
    subtitle: "Add your email so we can notify you when zk.money opens.",
  },
}
