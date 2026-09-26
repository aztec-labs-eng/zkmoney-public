import { useState } from "react"
import { PrimaryGradientButton } from "@obsidion/web-ds"
import slide1 from "../../../assets/onboarding/slide-1.webp"
import slide2 from "../../../assets/onboarding/slide-2.webp"
import slide3 from "../../../assets/onboarding/slide-3.webp"

const slides = (handle: string) => [
  {
    img: slide1,
    title: `You are @${handle}`,
    body: "Anyone can now send funds to your @tag, but no one can see the amounts sent or who sent it.",
  },
  {
    img: slide2,
    title: "You are in control of your funds",
    body: "zk.money is non-custodial, so no one can spend, move, or freeze your funds.",
  },
  {
    img: slide3,
    title: "Payments inside zk.money are free",
    body: "The network fee on your payments is covered. No gas needed.",
  },
]

/**
 * Three slides, each waiting for the reader: "Next →" advances, the dots pick one directly so an
 * earlier slide can be re-read, and the last waits for "Let's go!", which lands the user on Home.
 *
 * `onStart` fires on the first advance, once, whichever control makes it. A hand-off enters here
 * rather than on a screen of its own, and a passkey prompt needs a tap: leaving the first slide is
 * that tap, so the work it begins runs while the user reads on.
 */
export function OnboardingCarousel({
  handle,
  onDone,
  onStart,
}: {
  handle: string
  onDone: () => void
  onStart?: () => void
}) {
  const [index, setIndex] = useState(0)
  const all = slides(handle)
  const { img } = all[index]
  const last = index === all.length - 1

  const goTo = (next: number) => {
    // Leaving the first slide by any control is the activation the hand-off needs; a dot that
    // jumped straight past it would skip the work the first tap is there to begin.
    if (index === 0 && next !== 0) onStart?.()
    setIndex(next)
  }

  return (
    <div className="ww-carousel" data-testid={`onboarding-slide-${index + 1}`}>
      <img className="ww-carousel__art" src={img} alt="" />
      {/* Every slide's copy is laid out in one shared cell, so the tallest sets the height and the
          art, dots and button stay put between slides. */}
      <div className="ww-carousel__copy">
        {all.map((slide, i) => (
          <div
            key={i}
            className={"ww-carousel__slide" + (i === index ? "" : " ww-carousel__slide--hidden")}
            aria-hidden={i !== index || undefined}
          >
            <h1 className="ww-carousel__title">{slide.title}</h1>
            <p className="ww-carousel__body">{slide.body}</p>
          </div>
        ))}
      </div>
      <div className="ww-carousel__dots" data-testid="carousel-dots">
        {all.map((_, i) => (
          <button
            key={i}
            type="button"
            className={[
              "zkm-btn-reset",
              "ww-carousel__dot",
              i === index ? "ww-carousel__dot--active" : "",
              i < index ? "ww-carousel__dot--complete" : "",
            ]
              .filter(Boolean)
              .join(" ")}
            aria-label={`Slide ${i + 1} of ${all.length}`}
            aria-current={i === index || undefined}
            onClick={() => goTo(i)}
          />
        ))}
      </div>
      <PrimaryGradientButton
        testId="carousel-next"
        title={last ? "Let's go!" : "Next →"}
        style={{ width: 354, maxWidth: "100%" }}
        onClick={() => {
          if (last) return onDone()
          if (index === 0) onStart?.()
          setIndex(index + 1)
        }}
      />
    </div>
  )
}
