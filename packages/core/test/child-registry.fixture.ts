// Started by child-registry.test.ts: spawns a detached and a plain child, prints their pids, waits to be stopped.
import { spawn } from "node:child_process"
import { ChildRegistry } from "../src/child-registry"

ChildRegistry.stopOnSignals(["SIGTERM"])
const grouped = spawn("sh", ["-c", "sleep 300 & wait"], { detached: true, stdio: "ignore" })
ChildRegistry.track(grouped, true)
const plain = spawn("sleep", ["300"], { stdio: "ignore" })
ChildRegistry.track(plain, false)
console.log(`${grouped.pid} ${plain.pid}`)
setInterval(() => {}, 1000)
