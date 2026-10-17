import { afterEach, describe, expect, mock, spyOn, test } from "bun:test"
import { OpencodeClient } from "@yukioshi/sdk/v2"
import { runInteractiveMode } from "@/cli/cmd/run/runtime"
import type { FooterApi, RunProvider } from "@/cli/cmd/run/types"

type SessionMessage = NonNullable<Awaited<ReturnType<OpencodeClient["session"]["messages"]>>["data"]>[number]

const provider: RunProvider = {
  id: "openai",
  name: "OpenAI",
  source: "api",
  env: [],
  options: {},
  models: {
    "gpt-5": {
      id: "gpt-5",
      providerID: "openai",
      api: {
        id: "openai",
        url: "https://openai.test",
        npm: "@ai-sdk/openai",
      },
      name: "Little Frank",
      capabilities: {
        temperature: true,
        reasoning: true,
        attachment: true,
        toolcall: true,
        input: {
          text: true,
          audio: false,
          image: false,
          video: false,
          pdf: false,
        },
        output: {
          text: true,
          audio: false,
          image: false,
          video: false,
          pdf: false,
        },
        interleaved: false,
      },
      cost: {
        input: 0,
        output: 0,
        cache: {
          read: 0,
          write: 0,
        },
      },
      limit: {
        context: 128000,
        output: 8192,
      },
      status: "active",
      options: {},
      headers: {},
      release_date: "2026-01-01",
    },
  },
}

const transportProviders: RunProvider[][] = []

function defer<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

function ok<T>(data: T) {
  return Promise.resolve({
    data,
    error: undefined,
    request: new Request("https://opencode.test"),
    response: new Response(),
  })
}

function footer(): FooterApi {
  let closed = false
  const closes = new Set<() => void>()

  const notify = () => {
    for (const fn of closes) fn()
  }

  return {
    get isClosed() {
      return closed
    },
    onPrompt: () => () => {},
    onQueuedRemove: () => () => {},
    onClose(fn) {
      if (closed) {
        fn()
        return () => {}
      }

      closes.add(fn)
      return () => {
        closes.delete(fn)
      }
    },
    event() {},
    append() {},
    idle() {
      return Promise.resolve()
    },
    close() {
      if (closed) {
        return
      }

      closed = true
      notify()
    },
    destroy() {
      if (closed) {
        return
      }

      closed = true
      notify()
    },
  }
}

afterEach(() => {
  mock.restore()
  transportProviders.length = 0
})

describe("run interactive runtime", () => {
  test("waits for provider metadata before eager replay transport bootstrap", async () => {
    const providersStarted = defer<void>()
    const providers = defer<void>()

    const sdk = new OpencodeClient()
    spyOn(sdk.config, "providers").mockImplementation(async () => {
      providersStarted.resolve()
      await providers.promise
      return ok({ providers: [provider], default: {} })
    })
    spyOn(sdk.session, "messages").mockImplementation(() =>
      ok([
        {
          info: {
            id: "msg-user-1",
            sessionID: "ses-1",
            role: "user",
            time: {
              created: 1,
            },
            agent: "build",
            model: {
              providerID: "openai",
              modelID: "gpt-5",
              variant: undefined,
            },
          },
          parts: [
            {
              id: "part-user-1",
              sessionID: "ses-1",
              messageID: "msg-user-1",
              type: "text",
              text: "hello",
            },
          ],
        } satisfies SessionMessage,
      ]),
    )
    spyOn(sdk.session, "get").mockRejectedValue(new Error("not needed"))
    spyOn(sdk.app, "agents").mockImplementation(() => ok([]))
    spyOn(sdk.experimental.resource, "list").mockImplementation(() => ok({}))
    spyOn(sdk.command, "list").mockImplementation(() => ok([]))

    const task = runInteractiveMode(
      {
        sdk,
        directory: "/tmp",
        sessionID: "ses-1",
        sessionTitle: "Session",
        resume: true,
        replay: true,
        replayLimit: 100,
        agent: "build",
        model: {
          providerID: "openai",
          modelID: "gpt-5",
        },
        variant: undefined,
        files: [],
        thinking: true,
        backgroundSubagents: false,
      },
      {
        createRuntimeLifecycle: async () => ({
          footer: footer(),
          onResize: () => () => {},
          refreshTheme: () => {},
          resetForReplay: () => Promise.resolve(),
          close: () => Promise.resolve(),
        }),
        streamTransport: Promise.resolve({
          createSessionTransport: async (input: { providers?: () => RunProvider[]; footer: FooterApi }) => {
            transportProviders.push(input.providers?.() ?? [])
            setTimeout(() => {
              input.footer.close()
            }, 0)
            return {
              runPromptTurn: async () => {},
              steerPrompt: () => false,
              selectSubagent: () => {},
              replayOnResize: async () => false,
              close: async () => {},
            }
          },
          formatUnknownError: (error: unknown) => (error instanceof Error ? error.message : String(error)),
        }),
      },
    )

    await providersStarted.promise

    expect(transportProviders).toEqual([])

    providers.resolve()

    await task

    expect(transportProviders).toEqual([[provider]])
  })

  for (const steer of [true, false]) {
    test(`config steer ${steer}: a prompt typed during a turn ${steer ? "goes into that turn" : "waits in the queue"}`, async () => {
      const sdk = new OpencodeClient()
      spyOn(sdk.config, "providers").mockImplementation(() => ok({ providers: [provider], default: {} }))
      spyOn(sdk.config, "get").mockImplementation(() => ok({ steer } as never))
      spyOn(sdk.session, "messages").mockImplementation(() => ok([]))
      spyOn(sdk.session, "get").mockRejectedValue(new Error("not needed"))
      spyOn(sdk.app, "agents").mockImplementation(() => ok([]))
      spyOn(sdk.experimental.resource, "list").mockImplementation(() => ok({}))
      spyOn(sdk.command, "list").mockImplementation(() => ok([]))

      const ui = footer()
      const submits = new Set<(prompt: { text: string; parts: [] }) => void>()
      const appended: { kind: string; text: string }[] = []
      ui.onPrompt = (fn) => {
        submits.add(fn)
        return () => {
          submits.delete(fn)
        }
      }
      ui.append = (commit) => {
        appended.push({ kind: commit.kind, text: commit.text })
      }
      const turns: string[] = []
      const steered: { text: string; agent: string | undefined }[] = []
      const gate = defer<void>()
      const started = defer<void>()

      const task = runInteractiveMode(
        {
          sdk,
          directory: "/tmp",
          sessionID: "ses-1",
          sessionTitle: "Session",
          resume: true,
          replay: false,
          replayLimit: 100,
          agent: "build",
          model: { providerID: "openai", modelID: "gpt-5" },
          variant: undefined,
          files: [],
          thinking: true,
          backgroundSubagents: false,
          initialInput: "one",
        },
        {
          createRuntimeLifecycle: async () => ({
            footer: ui,
            onResize: () => () => {},
            refreshTheme: () => {},
            resetForReplay: () => Promise.resolve(),
            close: () => Promise.resolve(),
          }),
          streamTransport: Promise.resolve({
            createSessionTransport: async () => ({
              runPromptTurn: async (next: { prompt: { text: string } }) => {
                turns.push(next.prompt.text)
                if (turns.length === 1) {
                  started.resolve()
                  await gate.promise
                  return
                }
                ui.close()
              },
              steerPrompt: (next: { agent: string | undefined; prompt: { text: string }; show: () => void }) => {
                steered.push({ text: next.prompt.text, agent: next.agent })
                next.show()
                return true
              },
              selectSubagent: () => {},
              replayOnResize: async () => false,
              close: async () => {},
            }),
            formatUnknownError: (error: unknown) => (error instanceof Error ? error.message : String(error)),
          }),
        },
      )

      await started.promise
      await Bun.sleep(20)
      for (const fn of submits) fn({ text: "two", parts: [] })
      if (steer) {
        expect(steered).toEqual([{ text: "two", agent: "build" }])
        expect(appended.filter((item) => item.kind === "user").map((item) => item.text)).toEqual(["one", "two"])
        gate.resolve()
        await Bun.sleep(20)
        ui.close()
      } else {
        expect(steered).toEqual([])
        gate.resolve()
      }
      await task
      expect(turns).toEqual(steer ? ["one"] : ["one", "two"])
    })
  }
})
