import { Link, useInRouterContext } from "react-router-dom"
import brandCopy from "./brand/brand.copy"
import { BrandTile } from "./brand/BrandTile/BrandTile"
import "./shell.css"

/** App-store tile + wordmark. A link to the wallet's front door where a router is mounted. */
export function BrandLockup() {
  const inRouter = useInRouterContext()
  const body = (
    <>
      <BrandTile />
      <span className="ww-brand__name">{brandCopy.name}</span>
    </>
  )
  if (!inRouter) return <div className="ww-brand">{body}</div>
  return (
    <Link to="/" className="ww-brand" aria-label="zk.money home">
      {body}
    </Link>
  )
}
