/** @jsxImportSource @opentui/solid */
import { Show } from "solid-js"
import {
  runVerificationPipeline,
  type Verification,
  type VerificationClient,
} from "@yukioshi/core/verification"
import { useTheme } from "../context/theme"
import { type Theme, DEFAULT_THEMES, resolveTheme as resolveThemeJson } from "../theme"
import { RGBA } from "@opentui/core"

export type TurnVerificationState =
  | { readonly status: "running" }
  | { readonly status: "completed"; readonly summary: Verification.Summary }

const DEFAULT_THEME_FALLBACK: Theme = resolveThemeJson(DEFAULT_THEMES.opencode, "dark")

function resolveTheme(customTheme?: Theme): Theme {
  if (customTheme) return customTheme
  try {
    return useTheme().theme
  } catch {
    return DEFAULT_THEME_FALLBACK
  }
}

/** Maps canonical verification status to appropriate theme color matching main UX. */
export function getVerificationColor(status: Verification.Status, theme: Theme): RGBA {
  switch (status) {
    case "VERIFIED":
      return theme.success
    case "FAILED":
      return theme.error
    case "PARTIALLY_VERIFIED":
      return theme.warning
    case "SKIPPED_BY_USER":
    case "UNAVAILABLE":
    default:
      return theme.textMuted
  }
}

/**
 * Renders a post-turn verification status element matching main's UX:
 * Shows running indicator while checks execute, and a colored status badge
 * with explanation upon completion.
 */
export function VerificationBadge(props: {
  readonly state?: TurnVerificationState
  readonly theme?: Theme
}) {
  const currentTheme = () => resolveTheme(props.theme)

  const completed = () =>
    props.state?.status === "completed" ? props.state : undefined

  return (
    <Show when={props.state}>
      <box marginTop={0}>
        <text>
          <Show when={props.state?.status === "running"}>
            <span style={{ fg: currentTheme().info }}>⟳ Verifying changes...</span>
          </Show>
          <Show when={completed()}>
            {(state) => (
              <>
                <span style={{ fg: getVerificationColor(state().summary.status, currentTheme()) }}>
                  ▣ {state().summary.status}
                </span>
                <span style={{ fg: currentTheme().textMuted }}> — {state().summary.explanation}</span>
              </>
            )}
          </Show>
        </text>
      </box>
    </Show>
  )
}
