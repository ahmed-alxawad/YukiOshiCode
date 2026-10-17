// Execution runner for scheduled tasks (`yukioshi schedule run <id>`).
// Executes prompt in the job's directory, captures output into logs,
// respects spending limits, and manages concurrency locks.

import { createOpencodeClient, type OpencodeClient } from "@yukioshi/sdk/v2"
import { existsSync } from "fs"
import { ChildRegistry } from "@yukioshi/core/child-registry"
import { PrivateAddressPermission } from "@yukioshi/core/permission/private-address"
import { MAX_TIMER_MS } from "@/util/timer"
import {
  acquireJobLock,
  findJob,
  loadJobs,
  saveJobs,
  writeRunLog,
  type ScheduleJob,
} from "./store"

export type RunJobResult = {
  status: "success" | "failed" | "skipped: budget" | "skipped: already running" | "skipped: disabled"
  sessionID?: string
  logPath?: string
  error?: string
}

/** A scheduled run that has not finished after this long is stopped (default 2 hours, at most about 24 days). */
export function maxRunMs(env: NodeJS.ProcessEnv = process.env) {
  const seconds = Number(env.YUKIOSHI_SCHEDULE_MAX_RUN_SECONDS)
  return Number.isFinite(seconds) && seconds > 0 ? Math.min(seconds * 1000, MAX_TIMER_MS) : 2 * 60 * 60 * 1000
}

/**
 * Records how a run ended on its job. Reads the store again instead of writing back the list loaded when the run
 * started: a run can last hours, and jobs added, edited or removed meanwhile must not be undone.
 */
export async function recordResult(jobId: string, lastRunAt: number, lastResult: string) {
  const jobs = await loadJobs()
  const current = jobs.find((j) => j.id === jobId)
  if (!current) return
  current.lastRunAt = lastRunAt
  current.lastResult = lastResult
  await saveJobs(jobs)
}

function pickModel(value?: string) {
  if (!value) return undefined
  const [providerID, ...rest] = value.split("/")
  return {
    providerID,
    modelID: rest.join("/"),
  }
}

function isBudgetExceeded(err: unknown): boolean {
  if (!err) return false
  const str = typeof err === "string" ? err : JSON.stringify(err)
  return /budget.*reached/i.test(str) || /budget.*exceeded/i.test(str)
}

export async function runJob(id: string): Promise<RunJobResult> {
  const jobs = await loadJobs()
  const job = jobs.find((j) => j.id === id || (id.length >= 6 && j.id.startsWith(id)))
  if (!job) {
    throw new Error(`Scheduled job not found: ${id}`)
  }

  if (!job.enabled) {
    return { status: "skipped: disabled" }
  }

  const lock = await acquireJobLock(job.id)
  if (!lock) {
    const msg = `Job ${job.id} is already running. Skipping.`
    const time = Date.now()
    const logPath = await writeRunLog(job.id, `[${new Date(time).toISOString()}] ${msg}\n`, time)
    await recordResult(job.id, time, "skipped: already running")
    return { status: "skipped: already running", logPath }
  }

  // Resolved once the run has written its log and result, so a stop signal can wait for that before the process exits.
  let settle: () => void = () => {}
  const settled = new Promise<void>((resolve) => (settle = resolve))
  const runTime = Date.now()
  const logLines: string[] = []
  function appendLog(line: string) {
    logLines.push(line)
    if (process.stdout.isTTY) {
      process.stdout.write(line + "\n")
    }
  }

  appendLog(`[${new Date(runTime).toISOString()}] Starting scheduled job "${job.name}" (${job.id})`)
  appendLog(`Directory: ${job.directory}`)
  appendLog(`Prompt: ${job.prompt}`)

  if (!existsSync(job.directory)) {
    const err = `Directory not found: ${job.directory}`
    appendLog(`[ERROR] ${err}`)
    const logPath = await writeRunLog(job.id, logLines.join("\n"), runTime)
    await recordResult(job.id, runTime, `failed: ${err}`)
    await lock.release()
    return { status: "failed", logPath, error: err }
  }

  try {
    const { Server } = await import("@/server/server")
    const { ServerAuth } = await import("@/server/auth")

    const fetchFn = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init)
      const headers = new Headers(request.headers)
      const auth = ServerAuth.header()
      if (auth) headers.set("Authorization", auth)
      return Server.Default().app.fetch(new Request(request, { headers }))
    }) as typeof globalThis.fetch

    const sdk = createOpencodeClient({
      baseUrl: "http://yukioshi.internal",
      fetch: fetchFn,
      directory: job.directory,
    })

    const modelInput = pickModel(job.model)
    const sessResult = await sdk.session.create({
      title: `Scheduled: ${job.name}`,
      agent: job.agent,
      model: modelInput ? { providerID: modelInput.providerID, id: modelInput.modelID } : undefined,
    })

    const sessionID = sessResult.data?.id
    if (!sessionID) {
      throw new Error("Failed to create session")
    }

    appendLog(`Session created: ${sessionID}`)

    if (job.review) {
      await sdk.v2.session.permission.mode.set({ sessionID, mode: "review" }).catch(() => {})
    } else if (job.auto) {
      await sdk.v2.session.permission.mode.set({ sessionID, mode: "auto-all" }).catch(() => {})
    }

    // Subscribe to events to collect execution stream and handle permission asks
    const events = await sdk.event.subscribe()
    let sessionError: unknown = null

    let loopDone = false
    const eventLoop = (async () => {
      for await (const event of events.stream) {
        if (loopDone) break
        if (event.type === "permission.asked") {
          const perm = event.properties
          if (perm.sessionID !== sessionID) continue
          // A scheduled run is unattended: a private-address webfetch ask cannot be auto-approved,
          // so refuse it with an explanation whatever job.auto says.
          if (PrivateAddressPermission.isPrivateAddressAsk(perm.metadata)) {
            appendLog(`[permission] refused ${perm.permission} (${perm.patterns?.join(", ")}): private network address`)
            await sdk.permission.reply({
              requestID: perm.id,
              reply: "reject",
              message: PrivateAddressPermission.refusalText(perm),
            })
          } else if (job.auto) {
            appendLog(`[permission] auto-approved ${perm.permission} (${perm.patterns?.join(", ")})`)
            await sdk.permission.reply({ requestID: perm.id, reply: "once" })
          } else {
            appendLog(`[permission] rejected ${perm.permission} (${perm.patterns?.join(", ")})`)
            await sdk.permission.reply({ requestID: perm.id, reply: "reject" })
          }
        }

        if (event.type === "message.part.updated") {
          const part = event.properties.part
          if (part.sessionID !== sessionID) continue
          if (part.type === "text" && part.text) {
            appendLog(part.text)
          } else if (part.type === "tool") {
            appendLog(`[tool] ${part.tool} (${part.state?.status})`)
          }
        }

        if (event.type === "session.error") {
          if (event.properties.sessionID === sessionID) {
            sessionError = event.properties.error
            appendLog(`[session.error] ${JSON.stringify(event.properties.error)}`)
          }
        }

        if (
          event.type === "session.status" &&
          event.properties.sessionID === sessionID &&
          event.properties.status.type === "idle"
        ) {
          break
        }
      }
    })()

    // Stop the run when it takes too long, or when the scheduler or the user ends this process, so its shell
    // commands and subagents are cancelled instead of left running (and the job locked) for hours.
    let timedOut = false
    let interrupted = false
    const limit = maxRunMs()
    const stopRun = () => sdk.session.abort({ sessionID }).catch(() => undefined)
    const timer = setTimeout(() => {
      timedOut = true
      appendLog(
        `[${new Date().toISOString()}] Stopping the run: it exceeded the ${Math.round(limit / 1000)}s limit (change it with YUKIOSHI_SCHEDULE_MAX_RUN_SECONDS)`,
      )
      void stopRun()
    }, limit)
    const unhook = ChildRegistry.onStop(async () => {
      interrupted = true
      await stopRun()
      await settled
    })

    // Send the prompt
    const promptResult = await sdk.session
      .prompt({
        sessionID,
        agent: job.agent,
        model: modelInput,
        parts: [{ type: "text", text: job.prompt }],
      })
      .finally(() => {
        clearTimeout(timer)
        unhook()
      })
    loopDone = true

    // Wait for event loop to conclude or drain
    await Promise.race([
      eventLoop.catch((e) => appendLog(`[event-stream error] ${String(e)}`)),
      new Promise((resolve) => setTimeout(resolve, 500)),
    ])

    let status: RunJobResult["status"] = "success"
    let statusText = "success"

    const assistantError = (promptResult.data as any)?.info?.error || (promptResult.data as any)?.error
    const effectiveError = promptResult.error || assistantError || sessionError

    if (timedOut) {
      status = "failed"
      statusText = `failed: timed out after ${Math.round(limit / 1000)}s`
      appendLog(`[${new Date().toISOString()}] ${statusText}`)
    } else if (interrupted) {
      status = "failed"
      statusText = "failed: interrupted (the process was told to stop)"
      appendLog(`[${new Date().toISOString()}] ${statusText}`)
    } else if (isBudgetExceeded(effectiveError)) {
      status = "skipped: budget"
      statusText = "skipped: budget"
      appendLog(`[${new Date().toISOString()}] skipped: budget`)
    } else if (promptResult.error) {
      status = "failed"
      const errName = (promptResult.error as any).name || (promptResult.error as any).message || "error"
      statusText = `failed: ${errName}`
      appendLog(`[${new Date().toISOString()}] Prompt error: ${JSON.stringify(promptResult.error)}`)
    } else if (assistantError) {
      status = "failed"
      const errName = (assistantError as any).name || (assistantError as any).message || "error"
      statusText = `failed: ${errName}`
      appendLog(`[${new Date().toISOString()}] Assistant error: ${JSON.stringify(assistantError)}`)
    } else if (sessionError) {
      status = "failed"
      statusText = `failed: error`
      appendLog(`[${new Date().toISOString()}] Session error: ${JSON.stringify(sessionError)}`)
    } else {
      appendLog(`[${new Date().toISOString()}] Completed successfully`)
    }

    const logPath = await writeRunLog(job.id, logLines.join("\n"), runTime)
    await recordResult(job.id, runTime, statusText)

    return {
      status,
      sessionID,
      logPath,
      ...(status === "failed" ? { error: statusText.replace(/^failed: /, "") + (timedOut ? " (change the limit with YUKIOSHI_SCHEDULE_MAX_RUN_SECONDS)" : "") } : {}),
    }
  } catch (err: any) {
    const errorMsg = err.message || String(err)
    appendLog(`[${new Date().toISOString()}] Execution failed: ${errorMsg}`)
    const logPath = await writeRunLog(job.id, logLines.join("\n"), runTime)
    await recordResult(job.id, runTime, `failed: ${errorMsg}`)
    return { status: "failed", logPath, error: errorMsg }
  } finally {
    await lock.release()
    settle()
  }
}
