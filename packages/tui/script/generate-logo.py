#!/usr/bin/env python3
"""Generates src/logo-art.ts from the official YukiOshi logos.

Terminals cannot draw vector graphics, so the emblem and the "YukiOshi" wordmark are traced
from the brand images into quadrant block characters (2x2 pixels per cell). Dark mode uses
assets/brand/yukioshi-code-emblem-dark.png and light mode yukioshi-code-emblem-light.png,
each with its own colours, measured from the image.

Requires Pillow. Run from the repository root:
    python3 packages/tui/script/generate-logo.py
"""

import json
import pathlib

from PIL import Image

ROOT = pathlib.Path(__file__).resolve().parents[3]
OUTPUT = ROOT / "packages/tui/src/logo-art.ts"

# Regions of each 1254x1254 source image: (left, top, right, bottom).
VARIANTS = {
    "dark": {
        "source": ROOT / "assets/brand/yukioshi-code-emblem-dark.png",
        "background": (1, 6, 20),
        "emblem": (281, 197, 973, 680),
        "wordmark": (162, 728, 1087, 867),
        "code": (383, 915, 872, 975),
    },
    "light": {
        "source": ROOT / "assets/brand/yukioshi-code-emblem-light.png",
        "background": (255, 255, 255),
        "emblem": (221, 140, 1033, 722),
        "wordmark": (97, 764, 1158, 928),
        "code": (352, 969, 901, 1053),
    },
}
COLOURS = 4

QUADRANTS = {0: " ", 1: "▘", 2: "▝", 3: "▀", 4: "▖", 5: "▌", 6: "▞", 7: "▛",
             8: "▗", 9: "▚", 10: "▐", 11: "▜", 12: "▄", 13: "▙", 14: "▟", 15: "█"}


def flat(image):
    # Pillow 12 renamed getdata(); support both.
    return image.get_flattened_data() if hasattr(image, "get_flattened_data") else image.getdata()


def distance(a, b):
    return sum((x - y) ** 2 for x, y in zip(a, b))


def is_lit(pixel, background):
    return sum(abs(a - b) for a, b in zip(pixel, background)) > 90


def solid_pixels(image, boxes, background):
    """Logo pixels well away from anti-aliased edges, for measuring the palette."""
    pixels = []
    for box in boxes:
        crop = image.crop(box)
        crop = crop.resize((crop.width // 3, crop.height // 3))
        pixels += [p for p in flat(crop) if sum(abs(a - b) for a, b in zip(p, background)) > 140]
    return pixels


def measure_palette(pixels):
    strip = Image.new("RGB", (len(pixels), 1))
    strip.putdata(pixels)
    quantized = strip.quantize(colors=COLOURS, method=Image.Quantize.MEDIANCUT)
    values = quantized.getpalette()[: COLOURS * 3]
    colours = [tuple(values[i * 3 : i * 3 + 3]) for i in range(COLOURS)]
    # Lightest first, so palette order is stable between runs.
    return sorted(colours, key=lambda c: -(0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]))


def majority_colour(image, box, background, palette, columns=None):
    crop = image.crop(box)
    if columns:
        crop = crop.crop((int(crop.width * columns[0]), 0, int(crop.width * columns[1]), crop.height))
    votes = [0] * len(palette)
    for pixel in flat(crop.resize((crop.width // 2, crop.height // 2))):
        if sum(abs(a - b) for a, b in zip(pixel, background)) > 140:
            votes[min(range(len(palette)), key=lambda i: distance(pixel, palette[i]))] += 1
    return palette[max(range(len(palette)), key=lambda i: votes[i])]


def interior_gaps(occupied, minimum):
    """Runs of empty positions with logo on both sides, at least `minimum` long."""
    gaps, start = [], None
    first = next((i for i, value in enumerate(occupied) if value), None)
    last = max((i for i, value in enumerate(occupied) if value), default=None)
    if first is None:
        return gaps
    for index in range(first, last + 1):
        if not occupied[index] and start is None:
            start = index
        if occupied[index] and start is not None:
            if index - start >= minimum:
                gaps.append((start, index))
            start = None
    return gaps


def keep_gaps(lit, span_count, cell_size, other_count, other_size, length, transpose):
    """Marks the sub-pixel that overlaps each thin interior gap most, so it stays empty.

    Gaps thinner than a sub-pixel (like the space between an "i" and its dot) otherwise
    straddle two sub-pixels that are both mostly logo, and the shapes merge.
    """
    cleared = set()
    for span in range(span_count):
        a, b = int(span * cell_size), max(int(span * cell_size) + 1, int((span + 1) * cell_size))
        if transpose:
            occupied = [any(lit[y][x] for y in range(a, min(b, len(lit)))) for x in range(length)]
        else:
            occupied = [any(lit[y][x] for x in range(a, min(b, len(lit[0])))) for y in range(length)]
        for gap_start, gap_end in interior_gaps(occupied, other_size * 0.3):
            overlap = [
                max(0.0, min(gap_end, (cell + 1) * other_size) - max(gap_start, cell * other_size))
                for cell in range(other_count)
            ]
            best = max(range(other_count), key=lambda cell: overlap[cell])
            if overlap[best] > 0:
                cleared.add((best, span) if transpose else (span, best))
    return cleared


def cell_colour(source, background, palette, col, row, sub_w, sub_h, width, height):
    """The palette colour most of the cell's solid logo pixels are closest to.

    Anti-aliased edge pixels are blends with the background, so they are ignored;
    otherwise every shape picks up a fringe of the palette's lightest colour.
    """
    votes = [0] * len(palette)
    x0, x1 = int(col * 2 * sub_w), min(width, int((col + 1) * 2 * sub_w) + 1)
    y0, y1 = int(row * 2 * sub_h), min(height, int((row + 1) * 2 * sub_h) + 1)
    for y in range(y0, y1):
        for x in range(x0, x1):
            pixel = source[x, y]
            strength = sum(abs(a - b) for a, b in zip(pixel, background))
            if strength > 140:
                # Fully coloured pixels outweigh tinted edge pixels.
                votes[min(range(len(palette)), key=lambda i: distance(pixel, palette[i]))] += strength * strength
    if not any(votes):
        return min(range(len(palette)), key=lambda i: distance(source[min(x0, width - 1), min(y0, height - 1)], palette[i]))
    return max(range(len(palette)), key=lambda i: votes[i])


def trace(image, box, rows, background, palette):
    crop = image.crop(box)
    width, height = crop.size
    # A terminal cell is about twice as tall as it is wide, and holds 2x2 quadrant pixels.
    cols = round(2 * rows * width / height)
    sub_w, sub_h = width / (cols * 2), height / (rows * 2)
    source = crop.load()
    lit = [[is_lit(source[x, y], background) for x in range(width)] for y in range(height)]
    # Sub-pixel (x, y) positions that must stay empty to keep thin gaps visible.
    cleared = keep_gaps(lit, cols * 2, sub_w, rows * 2, sub_h, height, transpose=False)
    cleared |= keep_gaps(lit, rows * 2, sub_h, cols * 2, sub_w, width, transpose=True)
    pixels = crop.resize((cols * 2, rows * 2), Image.LANCZOS).load()
    lines, parts = [], []
    for row in range(rows):
        line, colours = "", ""
        for col in range(cols):
            mask = 0
            for bit, (dx, dy) in enumerate(((0, 0), (1, 0), (0, 1), (1, 1))):
                x, y = col * 2 + dx, row * 2 + dy
                if is_lit(pixels[x, y], background) and (x, y) not in cleared:
                    mask |= 1 << bit
            line += QUADRANTS[mask]
            colours += str(cell_colour(source, background, palette, col, row, sub_w, sub_h, width, height)) if mask else " "
        trimmed = line.rstrip()
        lines.append(trimmed)
        parts.append(colours[: len(trimmed)])
    return {"lines": lines, "parts": parts}


def hex_colour(colour):
    return "#%02x%02x%02x" % colour


def main():
    data = {}
    for name, variant in VARIANTS.items():
        image = Image.open(variant["source"]).convert("RGB")
        background = variant["background"]
        palette = measure_palette(solid_pixels(image, (variant["emblem"], variant["wordmark"]), background))
        data[name] = {
            "palette": [hex_colour(c) for c in palette],
            "emblemLarge": trace(image, variant["emblem"], 12, background, palette),
            "emblemMedium": trace(image, variant["emblem"], 10, background, palette),
            "wordmark": trace(image, variant["wordmark"], 5, background, palette),
            # The "< / CODE >" line is drawn as text: letters and brackets keep the logo's colours.
            "code": {
                "text": hex_colour(majority_colour(image, variant["code"], background, palette, (0.3, 0.85))),
                "bracket": hex_colour(majority_colour(image, variant["code"], background, palette, (0.0, 0.12))),
            },
        }
    body = [
        "// Generated by packages/tui/script/generate-logo.py from assets/brand/yukioshi-code-emblem-dark.png",
        "// and yukioshi-code-emblem-light.png. Do not edit by hand.",
        "",
        "/** Quadrant-block lines; parts holds, per character, an index into the variant's palette. */",
        "export type LogoArt = { readonly lines: readonly string[]; readonly parts: readonly string[] }",
        "",
        "export type LogoVariant = {",
        "  readonly palette: readonly string[]",
        "  readonly emblemLarge: LogoArt",
        "  readonly emblemMedium: LogoArt",
        "  readonly wordmark: LogoArt",
        "  readonly code: { readonly text: string; readonly bracket: string }",
        "}",
        "",
        f"export const logoArt: {{ readonly dark: LogoVariant; readonly light: LogoVariant }} = {json.dumps(data, ensure_ascii=False, indent=2)}",
        "",
    ]
    OUTPUT.write_text("\n".join(body))
    for name, variant in data.items():
        print(f"{name}: palette {variant['palette']}, code {variant['code']}")
    print(f"wrote {OUTPUT.relative_to(ROOT)}")


if __name__ == "__main__":
    main()
