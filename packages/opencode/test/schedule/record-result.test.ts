import { describe, expect, it } from "bun:test"
import { maxRunMs, recordResult } from "../../src/schedule/runner"
import { MAX_TIMER_MS } from "../../src/util/timer"
import { loadJobs, saveJobs, type ScheduleJob } from "../../src/schedule/store"

const job = (id: string, name: string): ScheduleJob => ({
  id,
  name,
  cron: "0 0 1 1 *",
  prompt: "p",
  directory: "/tmp",
  auto: false,
  enabled: true,
  createdAt: 1,
})

describe("scheduled run bookkeeping", () => {
  it("records a result without undoing jobs added or removed while the run was going", async () => {
    await saveJobs([job("aaaaaaaa", "running"), job("bbbbbbbb", "to-be-removed")])
    // The run read the list above when it started. Meanwhile one job is added and one removed.
    await saveJobs([job("aaaaaaaa", "running"), job("cccccccc", "added-meanwhile")])
    await recordResult("aaaaaaaa", 123, "success")
    const jobs = await loadJobs()
    expect(jobs.map((j) => j.name)).toEqual(["running", "added-meanwhile"])
    expect(jobs[0]).toMatchObject({ lastRunAt: 123, lastResult: "success" })
    expect(jobs[1]!.lastResult).toBeUndefined()
  })

  it("keeps every result when several runs record at the same time", async () => {
    const ids = ["aaaaaaaa", "bbbbbbbb", "cccccccc", "dddddddd", "eeeeeeee"]
    await saveJobs(ids.map((id) => job(id, id)))
    await Promise.all(ids.map((id, index) => recordResult(id, index + 1, "success")))
    const jobs = await loadJobs()
    expect(jobs.map((j) => j.lastRunAt)).toEqual([1, 2, 3, 4, 5])
  })

  it("does nothing when the job was removed during the run", async () => {
    await saveJobs([job("cccccccc", "other")])
    await recordResult("aaaaaaaa", 5, "success")
    expect((await loadJobs()).map((j) => j.name)).toEqual(["other"])
  })

  it("keeps the run limit within what a timer can hold", () => {
    expect(maxRunMs({ YUKIOSHI_SCHEDULE_MAX_RUN_SECONDS: "3000000" })).toBe(MAX_TIMER_MS)
    expect(maxRunMs({ YUKIOSHI_SCHEDULE_MAX_RUN_SECONDS: "90" })).toBe(90_000)
    for (const bad of ["0", "-5", "NaN", "", "abc"]) {
      expect(maxRunMs({ YUKIOSHI_SCHEDULE_MAX_RUN_SECONDS: bad })).toBe(2 * 60 * 60 * 1000)
    }
  })
})
