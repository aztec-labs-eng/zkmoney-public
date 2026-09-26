import type { CSSProperties, ReactNode } from "react"

export interface GradientTextProps {
  children: ReactNode
  /** "brand" = purple→cyan (zk.money label); "title" = white→gray (section/card titles). */
  gradient?: "brand" | "title"
  /** Font size in px. Defaults: brand 12, title 20. */
  size?: number
  /** Font weight. Defaults: brand 400, title 600. */
  weight?: number
  /** Font family override; defaults to the display token. Both tokens are Sen. */
  family?: "display" | "body"
  className?: string
  style?: CSSProperties
}

/**
 * Gradient-masked text. `gradient="brand"` renders the purple→cyan brand
 * gradient (e.g. the "zk.money" card label); `gradient="title"` renders the
 * white→gray title gradient used on section and card titles.
 */
export function GradientText({
  children,
  gradient = "title",
  size,
  weight,
  family,
  className,
  style,
}: GradientTextProps) {
  const isBrand = gradient === "brand"
  return (
    <span
      className={["zkm-gradient-text", isBrand ? "zkm-gradient-text--brand" : "zkm-gradient-text--title", className]
        .filter(Boolean)
        .join(" ")}
      style={{
        fontSize: size ?? (isBrand ? 12 : 20),
        fontWeight: weight ?? (isBrand ? 400 : 600),
        fontFamily:
          family === "body" ? "var(--font-body)" : family === "display" ? "var(--font-display)" : undefined,
        ...style,
      }}
    >
      {children}
    </span>
  )
}

/** White→gray gradient title text (AppTheme.titleTextGradient). */
export function TitleGradientText(props: Omit<GradientTextProps, "gradient">) {
  return <GradientText {...props} gradient="title" />
}
