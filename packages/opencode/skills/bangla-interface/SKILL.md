---
name: bangla-interface
description: How to keep Bangla explanations correct and polite when answers.language is bangla, mixed or auto — the polite আপনি register, which technical terms stay English, why code and commit messages stay English, and worked examples of good Bangla explanations. Use when asked to explain in Bangla or Bangla-English mix, to review an explanation for register or correctness, or when the user's messages are in Bengali script.
---

# Bangla explanations that stay polite and precise

When the answer language is bangla, mixed, or auto (and the user writes in Bengali script), your
explanations to the user are in Bangla. Everything else in this product stays English: the
interface, the code, the commit messages. This skill is the quality bar for the Bangla part.

## The register: আপনি, always

Write in the polite form. Address the reader with **আপনি** and use the matching verb forms
(করছি, করছেন, দেখুন, হবে). Never use the familiar তুমি or the intimate তুই — a coding assistant
that says তুমি to its user reads as rude, and তুই is only acceptable between very close friends.

- Good: "আমি file টা read করে দেখছি।"
- Bad:  "আমি file টা read করে দেখছি, তুমি wait করো।"

Impersonal constructions are also polite and often smoother than a direct আপনি: "এটা করলে test
fail করবে" beats "তুমি এটা করলে fail করবে" when you mean the change, not the person.

## What stays English

Code and its words are never translated. Keep English:

- code, identifiers, function and variable names, file paths, shell commands
- commit messages (subjects and bodies) — they are code artifacts
- interface strings and UI labels
- technical terms that are normally used untranslated by Bangladeshi developers

Common terms that stay English: `function`, `variable`, `loop`, `array`, `string`, `API`,
`database`, `commit`, `branch`, `pull request`, `deploy`, `bug`, `test`, `build`, `server`,
`async`, `promise`, `type`, `interface`. Translating these ("ফাংশন", "ভেরিয়েবল") reads as
textbookish; Bangladeshi developers say "function", "variable".

Words that do have natural Bangla equivalents, use them: লিখুন, দেখুন, চালান, পরিবর্তন, সমস্যা,
কারণ, তাই, প্রথমে, তারপর.

## Mixed mode

Mixed mode is the default voice of most Bangladeshi technical chat: Bangla grammar and connectors
carrying English technical nouns inline. Do not force a Bangla word where the English one is what
people actually say, and do not write whole English sentences inside a Bangla explanation.

- Good: "এই function টা async, তাই promise return করে — await না দিলে value পাবেন না।"
- Bad:  "This function is async so it returns a promise — আপনাকে await ব্যবহার করতে হবে।"

## Worked examples

Explaining a change (bangla mode):

> আমি `parseDate` function টায় timezone handle করছি। আগের code টা local time ধরে ছিল, তাই ভিন্ন
> timezone থেকে request এলে date এক দিন পিছিয়ে যাচ্ছিল। এখন `Intl.DateTimeFormat` দিয়ে UTC থেকে
> convert করছি।

Explaining why before doing (learn mode + bangla mode):

> প্রথমে test গুলো চালাব যেন বর্তমান অবস্থা বুঝতে পারি। এরপর `validate` function এ new rule টা
> যোগ করব, কারণ সব input ওখান দিয়েই যায়। শেষে আবার test চালিয়ে দেখব কিছু ভাঙেনি।

## Things that are not Bangla explanations

- Transliterating instead of writing Bengali script: "ami file ta pore dekhchi" — write the script.
- Mixing registers mid-answer (আপনি in one paragraph, তুমি in the next).
- Translating identifiers or commit messages: `সমষ্টি যোগ করা` for "add aggregation" helps nobody.
- Keeping the explanation in English "because it is about code" — that defeats the answer mode.
