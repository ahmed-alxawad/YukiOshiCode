// Started by child-registry.test.ts: a main thread whose worker thread starts a child, like the TUI worker does.
import { ChildRegistry } from "../src/child-registry"

ChildRegistry.stopOnSignals(["SIGTERM"])
const worker = new Worker(new URL("./child-registry.worker.fixture.ts", import.meta.url).href)
worker.onmessage = (event) => console.log(String(event.data.pid))
setInterval(() => {}, 1000)
