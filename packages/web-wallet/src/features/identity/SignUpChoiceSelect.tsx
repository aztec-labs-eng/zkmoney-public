import { useEffect, useId, useRef, useState, type KeyboardEvent } from "react"
import { Icon, type IconName } from "@obsidion/web-ds"
import { usePickerDismiss } from "../../ui/usePickerDismiss"

export interface SignUpChoiceOption<Id extends string = string> {
  id: Id
  icon: IconName
  label: string
  description: string
}

function Card({
  option,
  labelId,
  descriptionId,
}: {
  option: SignUpChoiceOption
  labelId?: string
  descriptionId?: string
}) {
  return (
    <>
      <span className="ww-choice__icon">
        <Icon name={option.icon} size={18} />
      </span>
      <span className="ww-choice__text">
        <b id={labelId}>{option.label}</b>
        <small id={descriptionId}>{option.description}</small>
      </span>
    </>
  )
}

/**
 * Where a new passkey lives: the chosen option drawn as a card that opens a listbox of the options.
 * One option is a plain card, since there is nothing to choose.
 */
export function SignUpChoiceSelect<Id extends string>({
  options,
  selected,
  onChange,
  labelledBy,
  disabled,
  testId = "phone-steps",
}: {
  options: readonly SignUpChoiceOption<Id>[]
  selected: Id
  onChange: (id: Id) => void
  /** The picker label's id. */
  labelledBy: string
  disabled?: boolean
  testId?: string
}) {
  const id = useId()
  const [open, setOpen] = useState(false)
  const [active, setActive] = useState(0)
  const anchorRef = useRef<HTMLDivElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const listRef = useRef<HTMLUListElement>(null)
  if (open && disabled) setOpen(false)

  usePickerDismiss(open, setOpen, anchorRef, triggerRef)
  useEffect(() => {
    // usePickerDismiss scrolls the list into view.
    if (open) listRef.current?.focus({ preventScroll: true })
  }, [open])

  const selectedIndex = Math.max(
    0,
    options.findIndex((option) => option.id === selected),
  )
  const current = options[selectedIndex]
  const optionId = (index: number) => `${id}-option-${index}`

  if (options.length === 1) {
    return (
      <div className="ww-choice">
        <div className="ww-choice__card">
          <Card option={current} />
        </div>
      </div>
    )
  }

  const openList = () => {
    setActive(selectedIndex)
    setOpen(true)
  }
  const close = () => {
    setOpen(false)
    triggerRef.current?.focus()
  }
  const choose = (index: number) => {
    onChange(options[index].id)
    close()
  }
  const onListKey = (event: KeyboardEvent) => {
    const last = options.length - 1
    const moves: Record<string, number> = {
      ArrowDown: active === last ? 0 : active + 1,
      ArrowUp: active === 0 ? last : active - 1,
      Home: 0,
      End: last,
    }
    if (Object.hasOwn(moves, event.key)) {
      event.preventDefault()
      setActive(moves[event.key])
    } else if (event.key === "Enter" || event.key === " ") {
      event.preventDefault()
      choose(active)
    } else if (event.key === "Tab") {
      // The list is gone before the browser moves focus, so it moves from the trigger: Tab goes
      // past it, Shift+Tab stays on it, kept from the sheet's own focus wrap.
      close()
      if (event.shiftKey) {
        event.preventDefault()
        event.stopPropagation()
      }
    }
  }

  return (
    <div className="ww-choice" ref={anchorRef}>
      <button
        ref={triggerRef}
        type="button"
        className="zkm-btn-reset ww-choice__card ww-choice__trigger"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={`${id}-list`}
        aria-labelledby={`${labelledBy} ${id}-label`}
        aria-describedby={`${id}-description`}
        disabled={disabled}
        data-testid={`${testId}-choice`}
        onClick={() => (open ? close() : openList())}
        onKeyDown={(event) => {
          if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return
          event.preventDefault()
          openList()
        }}
      >
        <Card option={current} labelId={`${id}-label`} descriptionId={`${id}-description`} />
        <span className="ww-choice__chevron">
          <Icon name="chevron-down" size={18} />
        </span>
      </button>
      {open && (
        <ul
          ref={listRef}
          id={`${id}-list`}
          className="ww-choice__list"
          role="listbox"
          aria-labelledby={labelledBy}
          aria-activedescendant={optionId(active)}
          tabIndex={-1}
          onKeyDown={onListKey}
        >
          {options.map((option, index) => (
            <li
              key={option.id}
              id={optionId(index)}
              className="ww-choice__option"
              role="option"
              aria-selected={option.id === selected}
              aria-labelledby={`${optionId(index)}-label`}
              aria-describedby={`${optionId(index)}-description`}
              data-active={index === active || undefined}
              data-testid={`${testId}-option-${option.id}`}
              onClick={() => choose(index)}
              onMouseMove={() => {
                if (index !== active) setActive(index)
              }}
            >
              <Card
                option={option}
                labelId={`${optionId(index)}-label`}
                descriptionId={`${optionId(index)}-description`}
              />
              <span className="ww-choice__check">
                {option.id === selected && <Icon name="check" size={18} />}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
