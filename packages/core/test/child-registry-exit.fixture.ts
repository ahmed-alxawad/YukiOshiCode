import { spawn } from "node:child_process"
import { ChildRegistry } from "../src/child-registry"

const killOnExit = process.argv[2] === "true"
const child = spawn("sleep", ["300"], { detached: true, stdio: "ignore" })
ChildRegistry.track(child, true, killOnExit)
process.stdout.write(String(child.pid))
process.exit(0)

