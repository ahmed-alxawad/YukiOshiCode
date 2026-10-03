import { RGBA, TextAttributes } from "@opentui/core"
import { useTerminalDimensions } from "@opentui/solid"
import { For, Match, Switch, createMemo } from "solid-js"
import { useTheme } from "../context/theme"
import { emblemLarge, emblemMedium, wordmark, type LogoArt } from "../logo-art"

type Segment = { text: string; part: string }

// Splits a traced line into runs of the same logo part so each run is one text node.
function segments(line: string, parts: string): Segment[] {
  const result: Segment[] = []
  const chars = Array.from(line)
  for (const [index, char] of chars.entries()) {
    const part = char === " " ? " " : (parts[index] ?? "w")
    const last = result.at(-1)
    if (last && last.part === part) last.text += char
    else result.push({ text: char, part })
  }
  return result
}

export function Logo() {
  const { theme } = useTheme()
  const dimensions = useTerminalDimensions()

  // White crystal and "Yuki" follow the text colour, so the emblem stays visible on light
  // backgrounds; the ice and blue parts use the theme's accent and primary colours.
  const colour = (part: string): RGBA | undefined => {
    if (part === "w") return theme.text
    if (part === "i") return theme.accent
    if (part === "b") return theme.primary
    return undefined
  }

  // The full emblem needs about 19 rows, so smaller terminals get a shorter version.
  const size = createMemo(() => {
    const { width, height } = dimensions()
    if (width < 72) return "text"
    if (height >= 40) return "large"
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

  const Code = () => (
    <box flexDirection="row" height={1}>
      <text fg={theme.primary} attributes={TextAttributes.BOLD} selectable={false}>
        {"< /  "}
      </text>
      <text fg={theme.text} attributes={TextAttributes.BOLD} selectable={false}>
        C O D E
      </text>
      <text fg={theme.primary} attributes={TextAttributes.BOLD} selectable={false}>
        {"  >"}
      </text>
    </box>
  )

  return (
    <box flexDirection="column" alignItems="center">
      <Switch>
        <Match when={size() === "large"}>
          <Art art={emblemLarge} />
          <box height={1} />
        </Match>
        <Match when={size() === "medium"}>
          <Art art={emblemMedium} />
          <box height={1} />
        </Match>
      </Switch>
      <Switch>
        <Match when={size() === "text"}>
          <box flexDirection="row" height={1}>
            <text fg={theme.text} attributes={TextAttributes.BOLD} selectable={false}>
              Yuki
            </text>
            <text fg={theme.primary} attributes={TextAttributes.BOLD} selectable={false}>
              Oshi
            </text>
          </box>
        </Match>
        <Match when={true}>
          <Art art={wordmark} />
        </Match>
      </Switch>
      <Code />
    </box>
  )
}
