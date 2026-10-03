# Appearance

## Theme

YukiOshi Code uses its own theme by default, built from the YukiOshi brand
palette:

- **Dark mode** sits on the deep navy of the YukiOshi emblem, with snow-white
  text and sky and ice-blue accents.
- **Light mode** uses snow white with ink text and YukiOshi's deep blue and
  navy.

The terminal UI follows your terminal's background and switches between light
and dark on its own.

| Do                               | How                                                        |
| -------------------------------- | ---------------------------------------------------------- |
| switch theme                     | `ctrl+x t`, or **Switch theme** in the command palette (`ctrl+p`) |
| switch between light and dark    | **Switch to light mode** / **Switch to dark mode** in the command palette |
| keep the current mode            | **Lock theme mode** in the command palette                 |

Over thirty other themes are included (for example Catppuccin, Dracula, Gruvbox,
Nord, Tokyo Night, and Solarized). To choose the default, put it in `tui.json`
next to `yukioshi.json`, for example `~/.config/yukioshi/tui.json`:

```json
{ "theme": "yukioshi" }
```

Custom themes are JSON files with a `dark` and a `light` colour for each role;
see `packages/tui/src/theme/assets/yukioshi.json` for a complete example.

## Logo

The home screen shows the YukiOshi emblem and wordmark, drawn from the official
logo files: the dark logo in dark mode and the light logo in light mode. The
size follows your terminal:

| Terminal height  | Shows                                     |
| ---------------- | ----------------------------------------- |
| 44 rows or more  | large emblem, wordmark, and `< / CODE >`  |
| 34 to 43 rows    | smaller emblem, wordmark, and `< / CODE >` |
| fewer rows       | wordmark and `< / CODE >`                 |

Below 72 columns it shows the name as plain text. Make the window taller to see
the emblem.

## Keybindings

The leader key is `ctrl+x`. Keybindings can be changed in `tui.json` under
`keybinds`; open **Help** from the command palette to see the current ones.
