import type { ChildProcessWithoutNullStreams } from "child_process"
import { AsyncLocalStorage } from "node:async_hooks"
import path from "path"
import { Process } from "@/util/process"
import type { InstanceContext } from "@/project/instance-context"
import { ProjectTrust } from "@/project/trust"

type Child = Process.Child & ChildProcessWithoutNullStreams
type Project = Pick<InstanceContext, "directory" | "worktree">

/** Raised instead of starting a program that lies inside an untrusted project. */
export class ProjectProgramError extends Error {
  constructor(readonly program: string) {
    super(`refused to run ${program} from this untrusted project`)
  }
}

const untrusted = new AsyncLocalStorage<Project>()

/**
 * Runs `fn` with every launch inside it refusing the project's own files: a checkout can ship
 * node_modules/.bin, vendor/bin or a .venv under a built-in server's name.
 */
export function withoutProjectPrograms<T>(project: Project, fn: () => Promise<T>) {
  return untrusted.run(project, fn)
}

/** Throws when `file`, a program or library about to be loaded, lies inside the untrusted project. */
export function refuseProjectFile(file: string, cwd = process.cwd()) {
  const project = untrusted.getStore()
  const local = project && ProjectTrust.projectProgram(file, cwd, project)
  if (local) throw new ProjectProgramError(local)
}

export function spawn(cmd: string, args: string[], opts?: Process.Options): Child
export function spawn(cmd: string, opts?: Process.Options): Child
export function spawn(cmd: string, argsOrOpts?: string[] | Process.Options, opts?: Process.Options) {
  const args = Array.isArray(argsOrOpts) ? [...argsOrOpts] : []
  const cfg = Array.isArray(argsOrOpts) ? opts : argsOrOpts
  const cwd = cfg?.cwd ?? process.cwd()
  refuseProjectFile(cmd, cwd)
  // A script handed to an interpreter (node server.js) runs as much as the interpreter does.
  for (const arg of args) if (path.isAbsolute(arg)) refuseProjectFile(arg, cwd)
  const proc = Process.spawn([cmd, ...args], {
    ...cfg,
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  }) as Child

  if (!proc.stdin || !proc.stdout || !proc.stderr) throw new Error("Process output not available")

  return proc
}
