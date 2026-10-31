import "./styles.css"
import { mountDesktopApp } from "./app"

const root = document.querySelector<HTMLElement>("#app")
if (!root) throw new Error("Desktop app root is missing")

mountDesktopApp(root, window.kothoraDesktop)
