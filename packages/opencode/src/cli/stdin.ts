// Reads input piped into the CLI (`git diff | yukioshi run "review this"`).
//
// Without a message, stdin is the message, so it is read to the end. With a message, stdin is extra
// context: a program that starts YukiOshi with a pipe it never writes to or closes (the default for
// many spawn APIs and CI runners) would otherwise make YukiOshi wait forever without a word. So it
// waits a few seconds for the first data and carries on without stdin if none arrives.

const WAIT_MS = 3000

export async function readPipedInput(hasMessage: boolean, waitMs = WAIT_MS): Promise<string | undefined> {
  if (process.stdin.isTTY) return undefined
  if (!hasMessage) return Bun.stdin.text()

  const reader = Bun.stdin.stream().getReader()
  let timer: ReturnType<typeof setTimeout> | undefined
  const first = await Promise.race([
    reader.read(),
    new Promise<"timeout">((resolve) => {
      timer = setTimeout(() => resolve("timeout"), waitMs)
    }),
  ]).finally(() => clearTimeout(timer))

  if (first === "timeout") {
    process.stderr.write(
      `No input arrived on stdin within ${waitMs / 1000} s; continuing without it. ` +
        "To skip the wait, run with stdin closed (for example `< /dev/null`).\n",
    )
    return undefined
  }

  const decoder = new TextDecoder()
  let text = ""
  let next = first
  while (!next.done) {
    text += decoder.decode(next.value, { stream: true })
    next = await reader.read()
  }
  return text + decoder.decode()
}
