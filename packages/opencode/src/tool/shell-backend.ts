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
// Host plumbing that must reach the backend client itself, but never the workload: the docker
// client needs the user's daemon selection, ssh needs the agent socket to authenticate.
const CLIENT_ONLY: Record<"docker" | "ssh", readonly string[]> = {
  docker: ["DOCKER_HOST", "DOCKER_CONTEXT"],
  ssh: ["SSH_AUTH_SOCK"],
}
// The MCP allow-list forwards proxy settings by name and their values travel in the client's
// environment, so credentials in `scheme://user:password@host` form are dropped before a workload can read them.
const PROXY_VAR = /_proxy$/i
const PROXY_USERINFO = /^((?:[A-Za-z][A-Za-z0-9+.-]*:)?\/\/)([^/?#]*)@/

/** Copies the backend-client-only variables from the parent environment into the spawn environment. */
function addClientEnv(env: Record<string, string>, parent: NodeJS.ProcessEnv, backend: "docker" | "ssh") {
  for (const name of CLIENT_ONLY[backend]) {
    const value = parent[name]
    if (typeof value === "string" && value) env[name] = value
  }
}

/** Strips `user:password@` from proxy URLs; scheme, host and port are kept. */
function redactProxyCredentials(env: Record<string, string>) {
  for (const [name, value] of Object.entries(env)) {
    if (PROXY_VAR.test(name)) env[name] = value.replace(PROXY_USERINFO, "$1")
  }
  return env
}

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
  if (input.command.includes("\0")) throw new Error("the command cannot contain NUL bytes")
  const env = redactProxyCredentials(McpEnvironment.local({}, input.env))
  if (cfg.backend === "docker") {
    const docker = cfg.docker
    if (!docker?.image || !IMAGE.test(docker.image)) throw new Error("shell.docker.image is missing or invalid")
    const network = docker.network ?? "none"
    if (!NETWORK.test(network)) throw new Error("shell.docker.network is invalid")
    if (/[,\n]/.test(input.root)) throw new Error("the project path cannot be mounted into docker (it contains a comma or newline)")
    const rel = path.relative(input.root, input.cwd)
    const inside = rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel))
    const workdir = inside && rel ? path.posix.join("/work", ...rel.split(path.sep)) : "/work"
    if (!inside) console.warn(`[shell] ${input.cwd} is outside the project root ${input.root}, which is the only folder mounted into docker; running in /work instead`)
    const container = `yukioshi-${randomBytes(6).toString("hex")}`
    const pass = Object.keys(env).filter((name) => !HOST_ONLY.has(name) && /^[A-Za-z_][A-Za-z0-9_]*$/.test(name))
    // The client itself needs the daemon selection; added after `pass` so `-e` never forwards it into the container.
    addClientEnv(env, input.env, "docker")
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
  if (/[\0\r\n]/.test(input.cwd)) throw new Error("the working directory cannot contain NUL or newline characters")
  addClientEnv(env, input.env, "ssh")
  return {
    file: "ssh",
    args: [
      "-T",
      "-o", "BatchMode=yes",
      "-o", "ConnectTimeout=10",
      "-o", "StrictHostKeyChecking=yes",
      "-o", "ClearAllForwardings=yes",
      ...(ssh.port ? ["-p", String(ssh.port)] : []),
      ...(ssh.identity_file ? ["-i", ssh.identity_file, "-o", "IdentitiesOnly=yes"] : []),
      ssh.user ? `${ssh.user}@${ssh.host}` : ssh.host,
      "--",
      // ssh joins its arguments with spaces and hands them to the remote login shell, so quote once.
      // Without the cd the command would run in the remote home, not in the project folder.
      `cd ${quote(input.cwd)} && sh -c ${quote(input.command)}`,
    ],
    env,
  }
}

/** Best effort: stop a docker container whose local client was killed. A container that already
 * exited is fine; every other failure is warned about instead of being swallowed. */
export function killContainer(name: string, env: Record<string, string>) {
  let child: ReturnType<typeof spawn>
  try {
    child = spawn("docker", ["kill", name], { env, stdio: "ignore", detached: true })
  } catch (error) {
    console.warn(`[shell] could not spawn docker kill for container ${name}: ${error}`)
    return
  }
  child.on("error", (error) => console.warn(`[shell] could not kill container ${name}: ${error.message}`))
  child.on("exit", (code, signal) => {
    if (code !== 0) console.warn(`[shell] docker kill for container ${name} failed (${code !== null ? `exit ${code}` : `signal ${signal}`})`)
  })
  child.unref()
}
