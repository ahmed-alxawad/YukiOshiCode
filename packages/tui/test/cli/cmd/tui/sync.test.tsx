/** @jsxImportSource @opentui/solid */
import { describe, expect, test } from "bun:test"
import { tmpdir } from "../../../fixture/fixture"
import { mount, wait, json } from "./sync-fixture"
import type { GlobalEvent, PermissionRequest } from "@yukioshi/sdk/v2"

function branchEvent(branch: string, workspace?: string): GlobalEvent {
  return {
    directory: "/tmp/other",
    project: "proj_test",
    workspace,
    payload: {
      id: `evt_vcs_${branch}`,
      type: "vcs.branch.updated",
      properties: { branch },
    },
  }
}

function permissionAskedEvent(request: Partial<PermissionRequest> & { permission: string }): GlobalEvent {
  const full: PermissionRequest = {
    id: "per_test",
    sessionID: "ses_test",
    patterns: ["*"],
    metadata: {},
    always: [],
    ...request,
  }
  return {
    directory: "/tmp/opencode/packages/tui",
    project: "proj_test",
    workspace: undefined,
    payload: {
      id: "evt_permission_asked",
      type: "permission.asked",
      properties: full,
    },
  }
}

describe("tui sync", () => {
  test("refresh scopes sessions by default and lists project sessions when disabled", async () => {
    await using tmp = await tmpdir()
    await Bun.write(`${tmp.path}/kv.json`, "{}")
    const { app, kv, sync, session } = await mount(undefined, tmp.path)

    try {
      expect(kv.get("session_directory_filter_enabled", true)).toBe(true)
      expect(session.at(-1)?.searchParams.get("roots")).toBeNull()
      expect(session.at(-1)?.searchParams.get("scope")).toBeNull()
      expect(session.at(-1)?.searchParams.get("path")).toBe("packages/tui")

      kv.set("session_directory_filter_enabled", false)
      await sync.session.refresh()

      expect(session.at(-1)?.searchParams.get("scope")).toBe("project")
      expect(session.at(-1)?.searchParams.get("path")).toBeNull()
      expect(session.at(-1)?.searchParams.get("roots")).toBeNull()
    } finally {
      app.renderer.destroy()
    }
  })

  test("vcs branch updates only apply for the active workspace", async () => {
    await using tmp = await tmpdir()
    await Bun.write(`${tmp.path}/kv.json`, "{}")
    const { app, emit, project, sync } = await mount(undefined, tmp.path)

    try {
      expect(sync.data.vcs?.branch).toBe("main")

      project.workspace.set("ws_a")
      emit(branchEvent("other", "ws_b"))
      await Bun.sleep(30)

      expect(sync.data.vcs?.branch).toBe("main")

      emit(branchEvent("feature", "ws_a"))
      await wait(() => sync.data.vcs?.branch === "feature")

      expect(sync.data.vcs?.branch).toBe("feature")
    } finally {
      app.renderer.destroy()
    }
  })

  test("permission mode: manual leaves the ask pending for the user", async () => {
    await using tmp = await tmpdir()
    await Bun.write(`${tmp.path}/kv.json`, "{}")
    const { app, emit, sync, permission } = await mount(
      (url) => (url.pathname.startsWith("/permission/") ? json({}) : undefined),
      tmp.path,
    )

    try {
      expect(permission.mode).toBe("manual")
      emit(permissionAskedEvent({ id: "per_manual", sessionID: "ses_test", permission: "bash" }))
      await wait(() => (sync.data.permission["ses_test"]?.length ?? 0) > 0)
      expect(sync.data.permission["ses_test"]?.[0]?.id).toBe("per_manual")
    } finally {
      app.renderer.destroy()
    }
  })

  test("permission mode: auto auto-resolves a low-risk ask without leaving it pending", async () => {
    await using tmp = await tmpdir()
    await Bun.write(`${tmp.path}/kv.json`, "{}")
    const { app, emit, sync, permission } = await mount(
      (url) => (url.pathname.startsWith("/permission/") ? json({}) : undefined),
      tmp.path,
    )

    try {
      permission.set("auto")
      emit(permissionAskedEvent({ id: "per_auto_low", sessionID: "ses_test", permission: "read" }))
      await Bun.sleep(30)
      expect(sync.data.permission["ses_test"]).toBeUndefined()
    } finally {
      app.renderer.destroy()
    }
  })

  test("permission mode: auto still leaves a high-risk ask pending", async () => {
    await using tmp = await tmpdir()
    await Bun.write(`${tmp.path}/kv.json`, "{}")
    const { app, emit, sync, permission } = await mount(
      (url) => (url.pathname.startsWith("/permission/") ? json({}) : undefined),
      tmp.path,
    )

    try {
      permission.set("auto")
      emit(permissionAskedEvent({ id: "per_auto_high", sessionID: "ses_test", permission: "bash" }))
      await wait(() => (sync.data.permission["ses_test"]?.length ?? 0) > 0)
      expect(sync.data.permission["ses_test"]?.[0]?.id).toBe("per_auto_high")
    } finally {
      app.renderer.destroy()
    }
  })

  test("permission mode: plan auto-resolves (never queues) a high-risk ask", async () => {
    await using tmp = await tmpdir()
    await Bun.write(`${tmp.path}/kv.json`, "{}")
    const { app, emit, sync, permission } = await mount(
      (url) => (url.pathname.startsWith("/permission/") ? json({}) : undefined),
      tmp.path,
    )

    try {
      permission.set("plan")
      emit(permissionAskedEvent({ id: "per_plan", sessionID: "ses_test", permission: "bash" }))
      await Bun.sleep(30)
      expect(sync.data.permission["ses_test"]).toBeUndefined()
    } finally {
      app.renderer.destroy()
    }
  })

  test("permission mode: auto-all auto-resolves anything, including high risk", async () => {
    await using tmp = await tmpdir()
    await Bun.write(`${tmp.path}/kv.json`, "{}")
    const { app, emit, sync, permission } = await mount(
      (url) => (url.pathname.startsWith("/permission/") ? json({}) : undefined),
      tmp.path,
    )

    try {
      permission.set("auto-all")
      emit(permissionAskedEvent({ id: "per_autoall", sessionID: "ses_test", permission: "bash" }))
      await Bun.sleep(30)
      expect(sync.data.permission["ses_test"]).toBeUndefined()
    } finally {
      app.renderer.destroy()
    }
  })
})
