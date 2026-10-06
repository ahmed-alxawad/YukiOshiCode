import { createResource, Show } from "solid-js"
import { DialogSelect } from "../../ui/dialog-select"
import { DialogConfirm } from "../../ui/dialog-confirm"
import { useDialog } from "../../ui/dialog"
import { useToast } from "../../ui/toast"

type Checkpoint = { id: string; label: string; files: string }

async function command(args: string[]) {
  const child = Bun.spawn(["yukioshi", ...args], { stdout: "pipe", stderr: "pipe" })
  const stderr = await new Response(child.stderr).text()
  await child.exited
  return stderr
}

export function DialogCheckpoints(props: { sessionID: string }) {
  const dialog = useDialog()
  const toast = useToast()
  const [items] = createResource(async () => {
    const output = await command(["checkpoint", "list", "--session", props.sessionID])
    return output
      .split("\n")
      .filter((line) => /^[0-9a-f]{12}\s/.test(line.trim()))
      .map((line) => {
        const [id, date, time, session, ...rest] = line.trim().split(/\s+/)
        return { id, label: `${date} ${time}`, files: rest.join(" ") } satisfies Checkpoint
      })
  })
  return (
    <Show when={items()} fallback={<text>Loading checkpoints…</text>}>
      <DialogSelect
        title="Git checkpoints"
        placeholder="Select a checkpoint"
        options={(items() ?? []).map((item) => ({
          title: item.label,
          value: item.id,
          description: item.files,
          onSelect: async () => {
            const confirmed = await DialogConfirm.show(
              dialog,
              "Restore checkpoint",
              `Restore ${item.id.slice(0, 12)} over the current worktree?`,
            )
            if (!confirmed) return
            const output = await command(["checkpoint", "restore", item.id, "--session", props.sessionID, "--yes"])
            dialog.clear()
            toast.show({ message: output.trim() || `Restored checkpoint ${item.id.slice(0, 12)}`, variant: "success" })
          },
        }))}
      />
    </Show>
  )
}
