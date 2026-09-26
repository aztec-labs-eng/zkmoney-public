import type { Meta, StoryObj } from "@storybook/react-vite"
import type { CSSProperties, ReactNode } from "react"
import { useState } from "react"
import {
  ActivityListRow,
  AmountChipRow,
  AmountSourceCard,
  AuroraBackground,
  Card,
  ComingSoonPill,
  ConfirmationSheetDetailRow,
  CopyableLinkRow,
  ConfirmationSheetHeader,
  ConfirmationSheetPartyCard,
  ConfirmationSheetSectionLabel,
  ConfirmationSheetShell,
  ContactRow,
  DestructiveActionButton,
  DoubleCheckIcon,
  GlassCircleButton,
  GlassRowCard,
  GradientInitialAvatar,
  GradientSpinner,
  GradientText,
  GradientToggle,
  HomeQuickActionsRow,
  Icon,
  IconCircle,
  LiquidGlassPill,
  ListRow,
  ModalBackground,
  OnchainPrivacyBanner,
  PaymentMethodGrid,
  PrimaryGradientButton,
  ProfileBackground,
  PromoBanner,
  PurpleBlueGradientBackground,
  RadialPurpleBackground,
  RowChevron,
  ScreenNavBar,
  SearchResultRow,
  SettingsRow,
  SheetDragHandle,
  SheetSurface,
  Shimmer,
  Spinner,
  StatusBadge,
  StatusPill,
  StoryRingAvatar,
  TabBar,
  TabBarShell,
  TitleGradientText,
  TitledGlassRowCard,
  Toast,
  TopNavBar,
  TopNavBarStackedTitle,
  TopNavIconButton,
  TransactionKindChip,
  TransferAmountCard,
  TwoPartyAmountCard,
  ZkMoneyRoot,
} from "@obsidion/web-ds"

const meta = {
  title: "Overview/All Components",
} satisfies Meta

export default meta
type Story = StoryObj<typeof meta>

/* ---- gallery chrome ---- */

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section style={{ marginBottom: 48 }}>
      <TitleGradientText size={20}>{title}</TitleGradientText>
      <div
        style={{
          display: "flex",
          flexWrap: "wrap",
          gap: 28,
          marginTop: 18,
          alignItems: "flex-start",
        }}
      >
        {children}
      </div>
    </section>
  )
}

function Specimen({
  name,
  children,
  width,
}: {
  name: string
  children: ReactNode
  width?: number | string
}) {
  return (
    <figure
      style={{ margin: 0, display: "flex", flexDirection: "column", gap: 8, width, minWidth: 0 }}
    >
      <figcaption
        style={{
          fontSize: 11,
          color: "var(--text-secondary)",
          fontFamily: "ui-monospace, monospace",
        }}
      >
        {name}
      </figcaption>
      {children}
    </figure>
  )
}

const blob = (style: CSSProperties) => (
  <span
    style={{
      position: "absolute",
      borderRadius: 9999,
      filter: "blur(40px)",
      opacity: 0.55,
      pointerEvents: "none",
      ...style,
    }}
  />
)

/** Brand aurora backdrop so glass surfaces have something to refract. */
function AuroraPanel({ children, width = 360 }: { children: ReactNode; width?: number }) {
  return (
    <div
      style={{
        position: "relative",
        width,
        borderRadius: 16,
        overflow: "hidden",
        background: "#141414",
        padding: "40px 10px 12px",
      }}
    >
      {blob({ width: 180, height: 180, left: -30, top: -60, background: "#a000ff" })}
      {blob({ width: 160, height: 160, right: -30, top: -20, background: "#0099ff" })}
      {blob({ width: 140, height: 140, left: 120, top: 36, background: "#FE708B" })}
      <div style={{ position: "relative" }}>{children}</div>
    </div>
  )
}

function InteractiveTabBar() {
  const [active, setActive] = useState("home")
  return <TabBar tabs={tabs} activeTab={active} onTabChange={setActive} />
}

function InteractiveShell() {
  const [active, setActive] = useState("home")
  return <TabBarShell tabs={tabs} activeTab={active} onTabChange={setActive} />
}

function InteractiveToggle({ initial }: { initial: boolean }) {
  const [on, setOn] = useState(initial)
  return <GradientToggle isOn={on} onChange={setOn} />
}

function InteractiveChips() {
  const [selected, setSelected] = useState<number | undefined>(25)
  return (
    <AmountChipRow values={[10, 25, 50, 100]} selectedValue={selected} onSelect={setSelected} />
  )
}

/* ---- shared fixtures (same data as the per-component stories) ---- */

const tabs = [
  { name: "home", label: "Home", icon: "home" },
  { name: "payments", label: "Payments", icon: "payments-arrows" },
  { name: "activity", label: "Activity", icon: "history-clock" },
  { name: "profile", label: "Profile", icon: "person" },
]

const amountLg = (text: string) => (
  <span style={{ fontFamily: "var(--font-display)", fontSize: 32, fontWeight: 600 }}>{text}</span>
)
const amountSm = (text: string) => (
  <span style={{ fontFamily: "var(--font-display)", fontSize: 16, fontWeight: 600 }}>{text}</span>
)

function DetailRow({ label, value }: { label: string; value: string }) {
  return (
    <div style={{ display: "flex", justifyContent: "space-between", fontSize: 14 }}>
      <span style={{ color: "var(--text-secondary)" }}>{label}</span>
      <span style={{ color: "var(--text-primary)" }}>{value}</span>
    </div>
  )
}

const ICON_NAMES = [
  "send",
  "receive",
  "scan",
  "qr-code",
  "wallet",
  "bank",
  "link",
  "bell",
  "lock",
  "person",
]
const BADGES = ["pending", "awaitingClaim", "request", "failed", "cancelled"] as const
const KINDS = [
  "received",
  "sent",
  "deposit",
  "withdraw",
  "incomingRequest",
  "outgoingRequest",
  "outgoingLink",
] as const

const sheet: CSSProperties = { background: "var(--surface-sheet)", borderRadius: 24 }
const bgTile: CSSProperties = {
  position: "relative",
  width: 220,
  height: 150,
  overflow: "hidden",
  borderRadius: 16,
}

/* ---- the page ---- */

export const AllComponents: Story = {
  render: () => (
    <div style={{ maxWidth: 1200 }}>
      <Section title="Foundations">
        <Specimen name="GradientText">
          <GradientText gradient="brand" size={28} weight={600}>
            zk.money
          </GradientText>
        </Specimen>
        <Specimen name="TitleGradientText">
          <TitleGradientText size={24}>Payments</TitleGradientText>
        </Specimen>
        <Specimen name="Icon">
          <div style={{ display: "flex", gap: 14 }}>
            {ICON_NAMES.map((n) => (
              <Icon key={n} name={n} size={20} color="#fff" />
            ))}
          </div>
        </Specimen>
        <Specimen name="IconCircle">
          <div style={{ display: "flex", gap: 12 }}>
            <IconCircle name="wallet" />
            <IconCircle name="lock-shield" />
            <IconCircle name="qr-code" size={56} glyphSize={22} />
          </div>
        </Specimen>
        <Specimen name="GlassCircleButton">
          <div style={{ display: "flex", gap: 12 }}>
            <GlassCircleButton onClick={() => {}} ariaLabel="Close">
              <Icon name="x" size={14} color="#fff" />
            </GlassCircleButton>
            <GlassCircleButton onClick={() => {}} size={56} ariaLabel="Scan QR">
              <Icon name="scan" size={20} color="#fff" />
            </GlassCircleButton>
          </div>
        </Specimen>
        <Specimen name="RowChevron">
          <div style={{ display: "flex", alignItems: "center", gap: 12, width: 200 }}>
            <span style={{ flex: 1, fontSize: 14, color: "#BFC2D7" }}>View all activity</span>
            <RowChevron />
          </div>
        </Specimen>
        <Specimen name="LiquidGlassPill">
          <div style={{ display: "flex", gap: 10 }}>
            <LiquidGlassPill label="Received" icon="reply" iconLeading />
            <LiquidGlassPill
              label="Owes you"
              icon="clock"
              foreground="#EED04E"
              tint="#EED04E"
              tintOpacity={0.18}
              fallbackFill="rgba(238,208,78,0.08)"
            />
          </div>
        </Specimen>
        <Specimen name="Card">
          <Card style={{ width: 280 }}>
            <div style={{ fontSize: 14, fontWeight: 500 }}>Payment sent</div>
            <div style={{ fontSize: 12, color: "#BFC2D7", marginTop: 4 }}>
              @honktheg00se &middot; Today, 09:41
            </div>
          </Card>
        </Specimen>
        <Specimen name="SheetDragHandle">
          <div
            style={{
              width: 220,
              background: "#212121",
              borderRadius: "24px 24px 0 0",
              padding: "8px 24px 20px",
              display: "flex",
              justifyContent: "center",
            }}
          >
            <SheetDragHandle />
          </div>
        </Specimen>
        <Specimen name="ZkMoneyRoot">
          <ZkMoneyRoot style={{ width: 280, borderRadius: 12 }}>
            <div style={{ fontSize: 14, fontWeight: 600 }}>Your balance is private</div>
            <div style={{ fontSize: 12, color: "#BFC2D7", marginTop: 4 }}>
              The dark app canvas every surface sits on.
            </div>
          </ZkMoneyRoot>
        </Specimen>
      </Section>

      <Section title="Buttons">
        <Specimen name="PrimaryGradientButton" width={300}>
          <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            <PrimaryGradientButton title="Continue" trailingIcon="arrow-right" />
            <PrimaryGradientButton title="Continue" trailingIcon="arrow-right" isDisabled />
          </div>
        </Specimen>
        <Specimen name='PrimaryGradientButton buttonStyle="dark" (liquid glass)' width={300}>
          <AuroraPanel width={300}>
            <PrimaryGradientButton title="Not now" buttonStyle="dark" />
          </AuroraPanel>
        </Specimen>
        <Specimen name="DestructiveActionButton">
          <DestructiveActionButton title="Cancel payment" icon="x-circle" />
        </Specimen>
        <Specimen name="GradientToggle (interactive)">
          <div style={{ display: "flex", gap: 12 }}>
            <InteractiveToggle initial />
            <InteractiveToggle initial={false} />
          </div>
        </Specimen>
        <Specimen name="TopNavIconButton">
          <div style={{ display: "flex", gap: 8 }}>
            <TopNavIconButton icon="qr-code" ariaLabel="Show QR" />
            <TopNavIconButton icon="bell" ariaLabel="Notifications" />
            <TopNavIconButton icon="ellipsis" ariaLabel="More" />
          </div>
        </Specimen>
        <Specimen name="HomeQuickActionsRow" width={340}>
          <HomeQuickActionsRow
            actions={[
              { title: "Send", icon: "send" },
              { title: "Scan", icon: "scan" },
              { title: "Add funds", icon: "arrow-down-circle" },
              { title: "Withdraw", icon: "arrow-up-circle" },
            ]}
          />
        </Specimen>
      </Section>

      <Section title="Avatars">
        <Specimen name="GradientInitialAvatar">
          <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
            <GradientInitialAvatar name="@cyphergirl" size={32} />
            <GradientInitialAvatar name="@honktheg00se" size={44} />
            <GradientInitialAvatar name="@archie" size={64} ringed />
          </div>
        </Specimen>
        <Specimen name="StoryRingAvatar">
          <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
            <StoryRingAvatar name="@cyphergirl" />
            <StoryRingAvatar name="@archie" unviewedRingColor="#A000FF" showNotificationDot />
            <StoryRingAvatar name="@honktheg00se" hasUnviewedStory={false} />
          </div>
        </Specimen>
      </Section>

      <Section title="Status & Feedback">
        <Specimen name="StatusBadge">
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            {BADGES.map((b) => (
              <StatusBadge key={b} label={b} badgeStyle={b} />
            ))}
          </div>
        </Specimen>
        <Specimen name="StatusPill">
          <div style={{ display: "flex", gap: 8 }}>
            <StatusPill label="Successful" icon="check-circle" iconColor="#56E79D" />
            <StatusPill label="Unclaimed" icon="clock" iconColor="#EED04E" />
          </div>
        </Specimen>
        <Specimen name="TransactionKindChip">
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            {KINDS.map((k) => (
              <TransactionKindChip key={k} kind={k} />
            ))}
          </div>
        </Specimen>
        <Specimen name="Spinner">
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <Spinner size={12} />
            <Spinner size={20} color="#A000FF" />
            <Spinner />
          </div>
        </Specimen>
        <Specimen name="GradientSpinner">
          <GradientSpinner />
        </Specimen>
        <Specimen name="DoubleCheckIcon">
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 4,
              color: "#BFC2D7",
              fontSize: 12,
            }}
          >
            <span>11:15</span>
            <DoubleCheckIcon />
          </div>
        </Specimen>
        <Specimen name="ComingSoonPill">
          <ComingSoonPill />
        </Specimen>
        <Specimen name="Shimmer">
          <Shimmer>
            <Card style={{ width: 260 }} padding={16}>
              <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                <span style={{ fontSize: 12, color: "#BFC2D7" }}>Total balance</span>
                <span style={{ fontSize: 28, fontWeight: 600, color: "#FDFDFD" }}>$1,284.09</span>
              </div>
            </Card>
          </Shimmer>
        </Specimen>
        <Specimen name="Toast" width={340}>
          <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            <Toast kind="success" message="All set, sending now." onDismiss={() => {}} />
            <Toast kind="error" message="Something went wrong!" />
            <Toast
              kind="progress"
              message="Keeping it private…"
              actionLabel="Open"
              onAction={() => {}}
            />
          </div>
        </Specimen>
      </Section>

      <Section title="Rows & Lists">
        <Specimen name="ActivityListRow" width={360}>
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            <ActivityListRow counterparty="@cyphergirl" timestamp="Today, 11:15" amount="+$25.23" />
            <ActivityListRow
              counterparty="Payment link"
              avatarIcon="link"
              timestamp="12 Jul, 18:02"
              amount="-$50.00"
              statusLabel="Unclaimed"
              actions={[
                { title: "Share", icon: "share", actionStyle: "gradient" },
                { title: "Cancel", actionStyle: "neutral" },
              ]}
            />
          </div>
        </Specimen>
        <Specimen name="ContactRow" width={320}>
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            <ContactRow tag="cyphergirl" onClick={() => {}} />
            <ContactRow tag="0x8f31…c2ab" name="Trading Wallet" isL1 onClick={() => {}} />
          </div>
        </Specimen>
        <Specimen name="SearchResultRow" width={320}>
          <SearchResultRow title="@honktheg00se" subtitle="zk.money" onClick={() => {}} />
        </Specimen>
        <Specimen name="ListRow" width={320}>
          <ListRow
            title="zk.money tag"
            subtitle="Send instantly to any @tag"
            leading={<IconCircle name="at" />}
            trailing={<RowChevron />}
          />
        </Specimen>
        <Specimen name="SettingsRow (in GlassRowCard)" width={320}>
          <GlassRowCard>
            <SettingsRow
              icon="person"
              label="Account"
              onClick={() => {}}
              trailing={<RowChevron />}
            />
            <SettingsRow
              icon="lock"
              label="Security"
              onClick={() => {}}
              trailing={<RowChevron />}
            />
          </GlassRowCard>
        </Specimen>
        <Specimen name="GlassRowCard" width={320}>
          <GlassRowCard>
            <DetailRow label="To" value="@honktheg00se" />
            <DetailRow label="Amount" value="$50.00" />
          </GlassRowCard>
        </Specimen>
        <Specimen name="TitledGlassRowCard" width={320}>
          <TitledGlassRowCard title="Details">
            <DetailRow label="Network fee" value="$0.12" />
            <DetailRow label="Total" value="$50.12" />
          </TitledGlassRowCard>
        </Specimen>
        <Specimen name="CopyableLinkRow" width={320}>
          <CopyableLinkRow url="https://paylink.test.zk.money/request#abc123" onCopy={() => {}} />
        </Specimen>
      </Section>

      <Section title="Navigation">
        <Specimen name="TopNavBar" width={360}>
          <TopNavBar
            title="Activity"
            leading={<TopNavIconButton icon="search" ariaLabel="Search" />}
            trailing={<TopNavIconButton icon="filter" ariaLabel="Filter" />}
          />
        </Specimen>
        <Specimen name="TopNavBarStackedTitle">
          <TopNavBarStackedTitle name="@cyphergirl" handle="cyphergirl.zk.money" />
        </Specimen>
        <Specimen name="ScreenNavBar" width={360}>
          <ScreenNavBar title="Send" onLeading={() => {}} />
        </Specimen>
        <Specimen name="TabBar (interactive — tap the tabs)" width={360}>
          <AuroraPanel>
            <InteractiveTabBar />
          </AuroraPanel>
        </Specimen>
        <Specimen name="TabBarShell (interactive)" width={390}>
          <InteractiveShell />
        </Specimen>
      </Section>

      <Section title="Payments">
        <Specimen name="AmountChipRow (interactive)" width={340}>
          <InteractiveChips />
        </Specimen>
        <Specimen name="PaymentMethodGrid" width={340}>
          <PaymentMethodGrid
            methods={[
              { label: "Send", icon: "send" },
              { label: "Receive", icon: "receive" },
              { label: "Link", icon: "link" },
              { label: "Scan", icon: "scan" },
              { label: "Bank", icon: "bank" },
              { label: "Card", icon: "wallet", disabled: true },
            ]}
          />
        </Specimen>
        <Specimen name="AmountSourceCard" width={340}>
          <AmountSourceCard
            senderName="You"
            senderHandle="@cyphergirl"
            balance={245.5}
            amount={amountLg("$50")}
          />
        </Specimen>
        <Specimen name="TransferAmountCard" width={340}>
          <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
            <TransferAmountCard
              roleLabel="From:"
              cornerStyle="top"
              person={{ name: "You", handle: "@cyphergirl" }}
              balanceText="$245.50"
              amount={amountLg("$50")}
            />
            <TransferAmountCard
              roleLabel="To:"
              cornerStyle="bottom"
              person={{ name: "External Wallet", handle: "0x1a2…9fe3" }}
              balanceText="$0"
              amount={amountLg("$50")}
              amountCaption="≈ 0.0128 ETH"
            />
          </div>
        </Specimen>
        <Specimen name="TwoPartyAmountCard" width={340}>
          <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
            <TwoPartyAmountCard
              role="youSend"
              cornerStyle="top"
              person={{ name: "You", handle: "@cyphergirl", ringed: true }}
              amount={amountSm("$120")}
            />
            <TwoPartyAmountCard
              role="receive"
              cornerStyle="bottom"
              person={{ name: "Goose", handle: "@honktheg00se" }}
              amount={amountSm("$120")}
            />
          </div>
        </Specimen>
      </Section>

      <Section title="Sheets & Modals">
        <Specimen name="SheetSurface" width={340}>
          <SheetSurface corners="all">
            <div
              style={{
                padding: "28px 24px 24px",
                display: "flex",
                flexDirection: "column",
                gap: 8,
              }}
            >
              <span
                style={{
                  fontFamily: "var(--font-display)",
                  fontSize: 20,
                  fontWeight: 600,
                  color: "#fff",
                }}
              >
                Payment received
              </span>
              <span
                style={{
                  fontFamily: "var(--font-body)",
                  fontSize: 14,
                  color: "var(--text-secondary)",
                }}
              >
                @cyphergirl sent you $25.00.
              </span>
            </div>
          </SheetSurface>
        </Specimen>
        <Specimen name="ConfirmationSheetHeader" width={340}>
          <div style={{ ...sheet, padding: "16px 24px" }}>
            <ConfirmationSheetHeader title="Confirm send" onClose={() => {}} />
          </div>
        </Specimen>
        <Specimen name="ConfirmationSheetSectionLabel + PartyCard + DetailRow" width={340}>
          <div style={{ ...sheet, padding: 24, display: "flex", flexDirection: "column", gap: 8 }}>
            <ConfirmationSheetSectionLabel>To</ConfirmationSheetSectionLabel>
            <ConfirmationSheetPartyCard
              name="@cyphergirl"
              handle="zk.money"
              trailingText="$25.00"
              avatar={<GradientInitialAvatar name="cyphergirl" size={40} />}
            />
            <div>
              <ConfirmationSheetDetailRow label="Fee" value="$0.02" />
              <ConfirmationSheetDetailRow label="Total" value="$25.02" />
            </div>
          </div>
        </Specimen>
        <Specimen name="ConfirmationSheetShell" width={360}>
          <div style={sheet}>
            <ConfirmationSheetShell
              title="Confirm send"
              onClose={() => {}}
              primaryAction={<PrimaryGradientButton title="Confirm" />}
            >
              <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                <ConfirmationSheetSectionLabel>To</ConfirmationSheetSectionLabel>
                <ConfirmationSheetPartyCard
                  name="@cyphergirl"
                  handle="zk.money"
                  trailingText="$25.00"
                  avatar={<GradientInitialAvatar name="cyphergirl" size={40} />}
                />
              </div>
            </ConfirmationSheetShell>
          </div>
        </Specimen>
      </Section>

      <Section title="Banners">
        <Specimen name="OnchainPrivacyBanner" width={340}>
          <OnchainPrivacyBanner />
        </Specimen>
        <Specimen name="PromoBanner" width={340}>
          <PromoBanner
            title="Invite friends and earn up to $50."
            ctaLabel="Invite friends"
            onCta={() => {}}
            onDismiss={() => {}}
          />
        </Specimen>
      </Section>

      <Section title="Backgrounds">
        <Specimen name="AuroraBackground">
          <div style={bgTile}>
            <AuroraBackground />
          </div>
        </Specimen>
        <Specimen name="RadialPurpleBackground">
          <div style={bgTile}>
            <RadialPurpleBackground />
          </div>
        </Specimen>
        <Specimen name="PurpleBlueGradientBackground">
          <div style={bgTile}>
            <PurpleBlueGradientBackground />
          </div>
        </Specimen>
        <Specimen name="ProfileBackground">
          <div style={bgTile}>
            <ProfileBackground />
          </div>
        </Specimen>
        <Specimen name="ModalBackground">
          <div style={bgTile}>
            <ModalBackground />
          </div>
        </Specimen>
      </Section>
    </div>
  ),
}
