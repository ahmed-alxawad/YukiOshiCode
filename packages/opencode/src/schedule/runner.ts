// Execution runner for scheduled tasks (`yukioshi schedule run <id>`).
// Executes prompt in the job's directory, captures output into logs,
// respects spending limits, and manages concurrency locks.

import { createOpencodeClient, type OpencodeClient } from "@yukioshi/sdk/v2"
import { existsSync } from "fs"
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
    job.lastRunAt = time
    job.lastResult = "skipped: already running"
    await saveJobs(jobs)
    return { status: "skipped: already running", logPath }
  }

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
    job.lastRunAt = runTime
    job.lastResult = `failed: ${err}`
    await saveJobs(jobs)
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

    if (job.auto) {
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
          if (job.auto) {
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

    // Send the prompt
    const promptResult = await sdk.session.prompt({
      sessionID,
      agent: job.agent,
      model: modelInput,
      parts: [{ type: "text", text: job.prompt }],
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

    if (isBudgetExceeded(effectiveError)) {
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
    job.lastRunAt = runTime
    job.lastResult = statusText
    await saveJobs(jobs)

    return { status, sessionID, logPath }
  } catch (err: any) {
    const errorMsg = err.message || String(err)
    appendLog(`[${new Date().toISOString()}] Execution failed: ${errorMsg}`)
    const logPath = await writeRunLog(job.id, logLines.join("\n"), runTime)
    job.lastRunAt = runTime
    job.lastResult = `failed: ${errorMsg}`
    await saveJobs(jobs)
    return { status: "failed", logPath, error: errorMsg }
  } finally {
    await lock.release()
  }
}
