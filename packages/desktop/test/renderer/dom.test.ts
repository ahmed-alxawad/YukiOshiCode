import { afterEach, describe, expect, test } from "bun:test"
import { mountDesktopApp } from "../../src/renderer/app"
import type { KothoraDesktopBridge } from "../../src/renderer/global"

class FakeElement {
  className = ""
  textContent = ""
  value = ""
  id = ""
  title = ""
  type = ""
  placeholder = ""
  hidden = false
  disabled = false
  tabIndex = 0
  rows = 0
  children: FakeElement[] = []
  attributes = new Map<string, string>()
  listeners = new Map<string, Array<(event: Event) => void>>()

  constructor(readonly tagName: string) {}

  append(...nodes: FakeElement[]) {
    this.children.push(...nodes)
  }

  replaceChildren(...nodes: FakeElement[]) {
    this.children = nodes
    this.textContent = ""
  }

  setAttribute(name: string, value: string) {
    this.attributes.set(name, value)
  }

  addEventListener(name: string, listener: (event: Event) => void) {
    this.listeners.set(name, [...(this.listeners.get(name) ?? []), listener])
  }
}

const findClass = (node: FakeElement, className: string): FakeElement | undefined => {
  if (node.className.split(" ").includes(className)) return node
  return node.children.map((child) => findClass(child, className)).find(Boolean)
}

const bridge = (payload: string): KothoraDesktopBridge => ({
  listWorkspaceFiles: async () => [{ path: "unsafe.html", kind: "file" }],
  readWorkspaceFile: async () => payload,
  listChanges: async () => [],
  readDiff: async () => "",
  startTask: async () => ({ taskId: "one" }),
  cancelTask: async () => {},
})

const originalDocument = globalThis.document

afterEach(() => {
  Object.defineProperty(globalThis, "document", { configurable: true, value: originalDocument })
})

describe("desktop DOM states", () => {
  test("renders untrusted file content as text and exposes selected state", async () => {
    Object.defineProperty(globalThis, "document", {
      configurable: true,
      value: { createElement: (tag: string) => new FakeElement(tag) },
    })
    const root = new FakeElement("div")
    const payload = "<script>globalThis.compromised = true</script>"
    const controller = mountDesktopApp(root as unknown as HTMLElement, bridge(payload))
    await controller.load()
    await controller.selectFile("unsafe.html")

    const viewer = findClass(root, "viewer")
    const selected = findClass(root, "list-item")
    expect(viewer?.textContent).toBe(payload)
    expect(viewer?.children).toHaveLength(0)
    expect(selected?.attributes.get("aria-current")).toBe("true")
  })

  test("renders empty and error state messages", async () => {
    Object.defineProperty(globalThis, "document", {
      configurable: true,
      value: { createElement: (tag: string) => new FakeElement(tag) },
    })
    const root = new FakeElement("div")
    const api = bridge("")
    api.listWorkspaceFiles = async () => []
    api.listChanges = async () => []
    api.readDiff = async () => {
      throw new Error("cannot read diff")
    }
    const controller = mountDesktopApp(root as unknown as HTMLElement, api)
    await controller.load()
    expect(findClass(root, "empty")?.textContent).toBe("No workspace files")
    await controller.selectDiff("missing.ts")
    expect(findClass(root, "status")?.textContent).toBe("Error: cannot read diff")
    expect(findClass(root, "viewer")?.textContent).toBe("Content could not be loaded.")
  })
})
