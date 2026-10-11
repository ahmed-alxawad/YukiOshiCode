// Runs in a worker thread of child-registry.worker-host.fixture.ts.
import { spawn } from "node:child_process"
import { ChildRegistry } from "../src/child-registry"

const child = spawn("sleep", ["300"], { detached: true, stdio: "ignore" })
ChildRegistry.track(child, true)
postMessage({ pid: child.pid })
