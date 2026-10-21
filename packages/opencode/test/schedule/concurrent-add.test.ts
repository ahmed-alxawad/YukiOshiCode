import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import fs from "fs/promises"
import path from "path"
import { ScheduleAddCommand } from "../../src/cli/cmd/schedule"
import { loadJobs, saveJobs } from "../../src/schedule/store"
import { tmpdir } from "../fixture/fixture"

// `schedule add` run several times at once (a dotfiles script adding schedules in parallel) must keep every
// job, in jobs.json and in the crontab block. The crontab goes to a file through the YUKIOSHI_CRONTAB hook.
describe.skipIf(process.platform !== "linux")("schedule add run concurrently", () => {
  const previous = process.env.YUKIOSHI_CRONTAB
  beforeEach(() => saveJobs([]))
  afterEach(() => {
    if (previous === undefined) delete process.env.YUKIOSHI_CRONTAB
    else process.env.YUKIOSHI_CRONTAB = previous
  })

  it("keeps every job", async () => {
    await using tmp = await tmpdir()
    const crontab = path.join(tmp.path, "crontab")
    await fs.writeFile(crontab, "*/5 * * * * /home/u/backup.sh\n")
    process.env.YUKIOSHI_CRONTAB = crontab
    const names = ["job1", "job2", "job3", "job4", "job5"]

    await Promise.all(
      names.map((name) =>
        ScheduleAddCommand.handler({
          cron: "0 9 * * *",
          prompt: `prompt for ${name}`,
          name,
          dir: tmp.path,
          auto: false,
          review: false,
          _: [],
          $0: "yukioshi",
        } as never),
      ),
    )

    expect((await loadJobs()).map((job) => job.name).sort()).toEqual(names)
    const block = await fs.readFile(crontab, "utf8")
    expect(block).toContain("/home/u/backup.sh")
    expect(block.match(/schedule run /g)?.length).toBe(names.length)
  })
})
