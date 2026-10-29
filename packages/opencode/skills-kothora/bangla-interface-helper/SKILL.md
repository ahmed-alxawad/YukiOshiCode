---
name: bangla-interface-helper
description: Use when building, translating or fixing a user interface in Bangla (বাংলা, Bengali), or when a web app must support English and Bangla together. Covers Unicode Bangla text, fonts and line height, Bangla digits (০১২৩), dates, currency (৳), bilingual i18n setup and common rendering bugs.
---

# Bangla interface helper

Help build and translate interfaces in Bangla. Work in the user's project: read it first, use the i18n library it already has, and change as little as possible. Code, keys and identifiers stay in English; only the user-facing strings are Bangla.

## 1. Text

- Use Unicode (UTF-8) only. Add `<meta charset="utf-8">` and `<html lang="bn">` (or set `lang` per element when the page mixes languages).
- Text typed in legacy ANSI encodings (Bijoy, SutonnyMJ and similar) is not Unicode and shows as garbage in modern apps. Convert it to Unicode first; do not try to display it.
- Normalise to NFC before comparing, searching or storing: `text.normalize("NFC")`. Keep the zero-width joiner and non-joiner characters (U+200D, U+200C) and the hasanta (U+09CD) as typed; stripping them changes the word.
- Never cut a string by code unit or by `slice` for display or truncation. Use `Intl.Segmenter("bn", { granularity: "grapheme" })` so a conjunct or vowel sign is not split from its letter.
- Do not use `text-transform: uppercase` or `letter-spacing` on Bangla; Bangla has no letter case and spacing breaks the joined shapes.
- Sort with `Intl.Collator("bn")`, not with `<` on strings. Plural rules come from `Intl.PluralRules("bn")`.

## 2. Fonts

- Good open-licence web fonts on Google Fonts: Noto Sans Bengali, Hind Siliguri, Anek Bangla, Tiro Bangla (serif). Check the font's licence before bundling it in a product.
- Always add a fallback chain: `font-family: "Noto Sans Bengali", "Hind Siliguri", system-ui, sans-serif;`.
- Bangla has marks above and below the line, so use a taller line height than for Latin text: about 1.6 for body text and 1.3 or more for headings. Test with the stacked conjuncts, for example "দ্বিতীয়", "ক্ষ", "শ্রী".
- Bangla text is usually wider and taller than the English text it replaces. Do not fix widths or heights on buttons, tabs and table headers; allow wrapping and test the longest strings.
- To keep the page light, load only the Bengali range with `unicode-range: U+0980-09FF` (plus U+200C-200D, U+0964-0965 for the danda marks and joiners), or use `font-display: swap`.
- In PDFs, canvas and image text, make sure the font is embedded; many PDF libraries need a shaping engine to join Bangla letters correctly. Check a sample page visually.

## 3. Digits, numbers, currency, dates

Use `Intl` instead of hand-written replacement tables.

```js
const bn = "bn-BD"
new Intl.NumberFormat(bn).format(1234567.5)            // Bangla digits, Bangladeshi grouping
new Intl.NumberFormat(bn, { style: "currency", currency: "BDT" }).format(2500) // with ৳
new Intl.DateTimeFormat(bn, { dateStyle: "long" }).format(new Date())
new Intl.RelativeTimeFormat(bn).format(-3, "day")      // "৩ দিন আগে"
```

- Check the actual output in the target browsers and Node versions; locale data differs slightly between engines.
- Bangla digits are ০ ১ ২ ৩ ৪ ৫ ৬ ৭ ৮ ৯. Show them in Bangla text if the product chooses to, but keep Latin digits for phone numbers, codes, OTPs, IDs, prices sent to a payment API and anything the user must copy. Let the user choose when it matters, and accept both when reading input: convert Bangla digits to Latin before parsing (`"০১৭".replace(/[০-৯]/g, (d) => "০১২৩৪৫৬৭৮৯".indexOf(d))`).
- `Intl` gives the Gregorian calendar in Bangla words. It does not give the Bangla calendar (বঙ্গাব্দ, with months বৈশাখ to চৈত্র). If the product needs it, use a tested library or a small table and say which rule it follows: the revised Bangladesh calendar and the Indian Bengali calendar differ.
- Store dates and times in UTC (ISO 8601) and format only for display, in the user's time zone (`Asia/Dhaka`, UTC+6, no daylight saving).

## 4. Bilingual i18n setup for a web app

1. Find what the project already uses (`next-intl`, `react-i18next`, `vue-i18n`, `@angular/localize`, `formatjs`). Use that. If there is none, suggest one that fits the framework and ask before adding a dependency.
2. Keep one message file per language (`messages/en.json`, `messages/bn.json`) with the same keys. English is the source and the fallback. Use stable, meaningful keys (`checkout.pay_button`), never the English sentence.
3. Use ICU message format for plurals and variables: `"{count, plural, one {# টি আইটেম} other {# টি আইটেম}}"`. Do not build sentences by joining strings, because Bangla word order differs.
4. Set `lang` on `<html>` from the active locale, and pick the font and line height by locale (for example `html[lang="bn"] { font-family: ...; line-height: 1.6 }`).
5. Detect the locale in this order: the user's saved choice, then the URL (`/bn/...`) or cookie, then `Accept-Language`, then English. Add a visible language switch.
6. Fail the build or a test when a key is missing in `bn.json`, so no English-only string ships by accident.
7. Translate in the polite form (আপনি, "করুন", "দেখুন"). Keep product names, brand names and widely used technical words (login, email, OTP) as users know them. Machine-translated strings must be marked for a native speaker to review before release.
8. Bangla is written left to right, so no right-to-left layout is needed.

## 5. Check before finishing

- Render the key screens in Bangla and look for: broken or detached marks, clipped lines, overflowing buttons, tofu boxes (missing font), mixed digits.
- Run the project's tests and typecheck. Add a test that every key in `en.json` exists in `bn.json`.
- Say what you could not check, for example fonts on a real phone.
