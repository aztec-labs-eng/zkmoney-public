import { Link, useInRouterContext } from "react-router-dom"
import appIconGlow from "../assets/home/app-icon-glow.svg"
import "./shell.css"

/** App-store tile + wordmark. A link to the wallet's front door where a router is mounted. */
export function BrandLockup() {
  const inRouter = useInRouterContext()
  const body = (
    <>
      <span className="ww-brand__tile" aria-hidden>
        <img src={appIconGlow} alt="" />
        <span>zk.</span>
        <span>money</span>
      </span>
      <span className="ww-brand__name">zk.money</span>
    </>
  )
  if (!inRouter) return <div className="ww-brand">{body}</div>
  return (
    <Link to="/" className="ww-brand" aria-label="zk.money home">
      {body}
    </Link>
  )
}
