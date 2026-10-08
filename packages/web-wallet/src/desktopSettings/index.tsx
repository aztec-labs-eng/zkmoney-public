// Loaded only in desktop builds, at the launcher's settings path; none of the wallet boot loads here.
import "../../../design-system/src/styles/styles.css"
import "../ui/shell.css"
import "./desktopSettings.css"
import { DesktopSettingsScreen } from "./DesktopSettingsScreen"

export default function DesktopSettings() {
  document.title = "zk.money Desktop — endpoint settings"
  return <DesktopSettingsScreen />
}
