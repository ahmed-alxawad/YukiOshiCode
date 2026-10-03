import { RGBA, TextAttributes } from "@opentui/core"
import { useTerminalDimensions } from "@opentui/solid"
import { For, Match, Switch, createMemo } from "solid-js"
import { useTheme } from "../context/theme"
import { logoArt, type EmblemArt, type LogoArt } from "../logo-art"

type Segment = { text: string; part: string }

// Splits a traced line into runs of the same logo colour so each run is one text node.
function segments(line: string, parts: string): Segment[] {
  const result: Segment[] = []
  const chars = Array.from(line)
  for (const [index, char] of chars.entries()) {
    const part = char === " " ? " " : (parts[index] ?? "0")
    const last = result.at(-1)
    if (last && last.part === part) last.text += char
    else result.push({ text: char, part })
  }
  return result
}

type Run = { text: string; fg?: string; bg?: string }

// Splits an emblem line into runs of cells with the same colours, one text node per run.
function runs(line: string, fg: string, bg: string): Run[] {
  const fgs = fg.split(" ")
  const bgs = bg.split(" ")
  const result: Run[] = []
  for (const [index, char] of Array.from(line).entries()) {
    const run = { text: char, fg: fgs[index] || undefined, bg: bgs[index] || undefined }
    const last = result.at(-1)
    if (last && last.fg === run.fg && last.bg === run.bg) last.text += char
    else result.push(run)
  }
  return result
}

export function Logo() {
  const { mode } = useTheme()
  const dimensions = useTerminalDimensions()

  // The official dark and light logos, each with its own colours.
  const variant = createMemo(() => (mode() === "light" ? logoArt.light : logoArt.dark))
  const colour = (part: string): RGBA | undefined => {
    if (part === " ") return undefined
    const palette = variant().palette
    return RGBA.fromHex(palette[Number(part)] ?? palette[0])
  }

  // The full logo needs about 23 rows; shorter terminals get the 12-row emblem, and below 34 rows
  // the emblem loses its detail, so only the wordmark is shown.
  const size = createMemo(() => {
    const { width, height } = dimensions()
    if (width < 72) return "text"
    if (height >= 44) return "large"
    if (height >= 34) return "medium"
    return "wordmark"
  })

  const Art = (props: { art: LogoArt }) => (
    <box flexDirection="column" alignItems="flex-start">
      <For each={props.art.lines}>
        {(line, index) => (
          <box flexDirection="row" height={1}>
            <For each={segments(line, props.art.parts[index()] ?? "")}>
              {(segment) => (
                <text fg={colour(segment.part)} selectable={false}>
                  {segment.text}
                </text>
              )}
            </For>
          </box>
        )}
      </For>
    </box>
  )

  // The emblem keeps its own colours per cell; a cell without a background is transparent.
  const Emblem = (props: { art: EmblemArt }) => (
    <box flexDirection="column" alignItems="flex-start">
      <For each={props.art.lines}>
        {(line, index) => (
          <box flexDirection="row" height={1}>
            <For each={runs(line, props.art.fg[index()] ?? "", props.art.bg[index()] ?? "")}>
              {(run) => (
                <text
                  fg={run.fg ? RGBA.fromHex(`#${run.fg}`) : undefined}
                  bg={run.bg ? RGBA.fromHex(`#${run.bg}`) : undefined}
                  selectable={false}
                >
                  {run.text}
                </text>
              )}
            </For>
          </box>
        )}
      </For>
    </box>
  )

  const Code = () => (
    <box flexDirection="row" height={1}>
      <text fg={RGBA.fromHex(variant().code.bracket)} attributes={TextAttributes.BOLD} selectable={false}>
        {"< /  "}
      </text>
      <text fg={RGBA.fromHex(variant().code.text)} attributes={TextAttributes.BOLD} selectable={false}>
        C O D E
      </text>
      <text fg={RGBA.fromHex(variant().code.bracket)} attributes={TextAttributes.BOLD} selectable={false}>
        {"  >"}
      </text>
    </box>
  )

  return (
    <box flexDirection="column" alignItems="center">
      <Switch>
        <Match when={size() === "large"}>
          <Emblem art={variant().emblemLarge} />
          <box height={1} />
        </Match>
        <Match when={size() === "medium"}>
          <Emblem art={variant().emblemMedium} />
          <box height={1} />
        </Match>
      </Switch>
      <Switch>
        <Match when={size() === "text"}>
          <box flexDirection="row" height={1}>
            <text fg={RGBA.fromHex(variant().code.text)} attributes={TextAttributes.BOLD} selectable={false}>
              Yuki
            </text>
            <text fg={RGBA.fromHex(variant().code.bracket)} attributes={TextAttributes.BOLD} selectable={false}>
              Oshi
            </text>
          </box>
        </Match>
        <Match when={true}>
          <Art art={variant().wordmark} />
        </Match>
      </Switch>
      <Code />
    </box>
  )
}
