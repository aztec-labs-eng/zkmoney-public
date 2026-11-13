import { useStore } from "@obsidion/front-core"
import { GradientSpinner, Icon } from "@obsidion/web-ds"
import { useState, type CSSProperties } from "react"
import { fmt } from "../../../lib/fmt"
import { openedSession, useSession } from "../../../session/session"
import { useDomEffect } from "../../../ui/useDomEffect"
import { usePhoneLayout } from "../../../ui/usePhoneLayout"
import { flowCopy } from "../operationCopy"
import { SAFE_SHOWN_MS, useKeepOpenNotice } from "../operations"
import type { TabPlace } from "../TabLine"
import copy from "./KeepOpenNotice.copy"
import styles from "./KeepOpenNotice.module.css"

const shown = { "--shown": `${SAFE_SHOWN_MS}ms` } as CSSProperties

/**
 * Says at the top of every page that closing it now would stop a transaction, then that it is sent.
 * A phone gets a notification card over the top bar, which a tap shrinks to a strip on the top edge;
 * a desktop gets a tab hanging from the window's top edge; the browser tab's title says it too.
 */
export function KeepOpenNotice() {
  return useStore(openedSession) ? <Notice /> : null
}

function Notice() {
  const notice = useKeepOpenNotice()
  const phone = usePhoneLayout()
  const [shrunk, shrink] = useState<string>()
  const place: TabPlace = useSession().account ? "tab" : "page"
  const keep = notice?.line === "keep"
  const live = notice ? flowCopy(notice.operation.flow).live : ""
  const title = notice && (keep ? fmt(copy.tabTitle.keep, { live }) : copy.tabTitle.safe)
  useDomEffect(() => {
    if (!title) return
    const was = document.title
    document.title = title
    return () => {
      document.title = was
    }
  }, [title])

  const summary = notice?.operation.summary ?? ""
  const doing = fmt(copy.doing, { live, summary }).trim()
  const ask = phone ? copy.phone : fmt(copy.desktop, { place })
  return (
    <>
      <p className={styles.announce} aria-live="polite">
        {notice && (keep ? [copy.title, doing, ask] : [copy.sent, summary]).join(". ")}
      </p>
      {notice &&
        (phone ? (
          keep && shrunk === notice.operation.operationId ? (
            <span
              className={styles.strip}
              data-testid="keep-open-notice"
              data-line={notice.line}
              data-shrunk
              aria-hidden
            >
              <span className={styles.progress} />
            </span>
          ) : keep ? (
            <button
              type="button"
              className={styles.card}
              data-testid="keep-open-notice"
              data-line={notice.line}
              aria-label={copy.shrink}
              onClick={() => shrink(notice.operation.operationId)}
            >
              <GradientSpinner size={28} />
              <span className={styles.text}>
                <span className={styles.title}>{copy.title}</span>
                <span className={styles.doing}>{doing}</span>
                <span className={styles.ask}>{ask}</span>
              </span>
              <span className={styles.progress} />
            </button>
          ) : (
            <div
              className={styles.card}
              data-testid="keep-open-notice"
              data-line={notice.line}
              style={shown}
              aria-hidden
            >
              <Icon name="check-circle" size={28} color="var(--accent-green)" />
              <span className={styles.text}>
                <span className={styles.title}>{copy.sent}</span>
                <span className={styles.doing}>{summary}</span>
              </span>
            </div>
          )
        ) : (
          <div
            className={styles.tab}
            data-testid="keep-open-notice"
            data-line={notice.line}
            style={shown}
            aria-hidden
          >
            <span className={styles.buddy} />
            <span className={styles.text}>
              <strong>{keep ? doing : copy.sent}</strong>
              <span className={styles.ask}>{keep ? ask : summary}</span>
            </span>
            {keep && <span className={styles.progress} />}
          </div>
        ))}
    </>
  )
}
