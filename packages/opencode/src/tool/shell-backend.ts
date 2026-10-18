import { spawn } from "node:child_process"
import { randomBytes } from "node:crypto"
import path from "path"
import { McpEnvironment } from "../mcp/environment"

export type Config = {
  backend?: "local" | "docker" | "ssh"
  docker?: { image: string; network?: string; mount?: "project" }
  ssh?: { host: string; user?: string; port?: number; identity_file?: string }
}

export type Plan = {
  file: string
  args: string[]
  env: Record<string, string>
  /** Docker container name, so it can be killed together with the local client. */
  container?: string
}

/** Single-quotes text for a POSIX shell. The only special character inside single quotes is the quote itself. */
export function quote(text: string) {
  return `'${text.replaceAll("'", `'\\''`)}'`
}

const HOST = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/
const USER = /^[A-Za-z0-9_][A-Za-z0-9._-]*$/
const IMAGE = /^[A-Za-z0-9][A-Za-z0-9._:/@-]*$/
const NETWORK = /^[A-Za-z0-9][A-Za-z0-9._-]*$/
// Variables that mean something only on the host; everything else of the MCP allow-list is passed into the container.
const HOST_ONLY = new Set(["PATH", "HOME", "USER", "TMPDIR", "SHELL"])

export function active(cfg: Config | undefined) {
  return cfg?.backend === "docker" || cfg?.backend === "ssh" ? cfg.backend : undefined
}

/** Refuse combinations that cannot work or would silently weaken what the user asked for. */
export function check(cfg: Config | undefined, sandboxEnabled: boolean) {
  if (cfg?.backend === "ssh" && sandboxEnabled)
    throw new Error(
      "sandbox.enabled cannot be combined with shell.backend \"ssh\": the OS sandbox only confines local processes. Turn one of them off.",
    )
}

export function plan(
  cfg: Config,
  input: { command: string; cwd: string; env: NodeJS.ProcessEnv; root: string },
): Plan {
  const env = McpEnvironment.local({}, input.env)
  if (cfg.backend === "docker") {
    const docker = cfg.docker
    if (!docker?.image || !IMAGE.test(docker.image)) throw new Error("shell.docker.image is missing or invalid")
    const network = docker.network ?? "none"
    if (!NETWORK.test(network)) throw new Error("shell.docker.network is invalid")
    if (/[,\n]/.test(input.root)) throw new Error("the project path cannot be mounted into docker (it contains a comma or newline)")
    const rel = path.relative(input.root, input.cwd)
    const inside = rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel))
    const workdir = inside && rel ? path.posix.join("/work", ...rel.split(path.sep)) : "/work"
    const container = `yukioshi-${randomBytes(6).toString("hex")}`
    const pass = Object.keys(env).filter((name) => !HOST_ONLY.has(name) && /^[A-Za-z_][A-Za-z0-9_]*$/.test(name))
    return {
      file: "docker",
      args: [
        "run", "--rm", "-i",
        "--name", container,
        "--network", network,
        "--mount", `type=bind,source=${input.root},target=/work`,
        "-w", workdir,
        // Names only: the values travel in the client's environment, never in argv.
        ...pass.flatMap((name) => ["-e", name]),
        docker.image,
        "sh", "-c", input.command,
      ],
      env,
      container,
    }
  }
  const ssh = cfg.ssh
  if (!ssh?.host || !HOST.test(ssh.host)) throw new Error("shell.ssh.host is missing or invalid")
  if (ssh.user !== undefined && !USER.test(ssh.user)) throw new Error("shell.ssh.user is invalid")
  if (ssh.port !== undefined && !(Number.isInteger(ssh.port) && ssh.port > 0 && ssh.port < 65536))
    throw new Error("shell.ssh.port is invalid")
  return {
    file: "ssh",
    args: [
      "-T",
      "-o", "BatchMode=yes",
      "-o", "StrictHostKeyChecking=yes",
      "-o", "ClearAllForwardings=yes",
      ...(ssh.port ? ["-p", String(ssh.port)] : []),
      ...(ssh.identity_file ? ["-i", ssh.identity_file, "-o", "IdentitiesOnly=yes"] : []),
      ssh.user ? `${ssh.user}@${ssh.host}` : ssh.host,
      "--",
      // ssh joins its arguments with spaces and hands them to the remote login shell, so quote once.
      `sh -c ${quote(input.command)}`,
    ],
    env,
  }
}

/** Best effort: stop a docker container whose local client was killed. Fails silently when it already exited. */
export function killContainer(name: string, env: Record<string, string>) {
  try {
    spawn("docker", ["kill", name], { env, stdio: "ignore", detached: true }).on("error", () => {}).unref()
  } catch {}
}
