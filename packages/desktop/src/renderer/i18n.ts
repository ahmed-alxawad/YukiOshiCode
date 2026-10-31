export const locales = ["en", "bn"] as const
export type Locale = (typeof locales)[number]

export const messageKeys = [
  "appName",
  "taskPromptLabel",
  "taskPromptPlaceholder",
  "startTask",
  "cancelTask",
  "selectWorkspace",
  "workspaceFilesLabel",
  "changedFilesLabel",
  "workspaceHeading",
  "changesHeading",
  "selectFileHeading",
  "ready",
  "loadingWorkspace",
  "taskRunning",
  "taskComplete",
  "taskCancelled",
  "taskFailed",
  "taskStatus",
  "taskPollingTimedOut",
  "errorStatus",
  "noWorkspaceFiles",
  "noChangedFiles",
  "fileHeading",
  "diffHeading",
  "changeCount",
  "loadingContent",
  "contentLoadError",
  "emptyFile",
  "selectReviewItem",
  "unexpectedError",
] as const

export type MessageKey = (typeof messageKeys)[number]
export type MessageCatalog = Readonly<Record<MessageKey, string>>
export type InterpolationValues = Readonly<Record<string, string | number>>

export const catalogs = {
  en: {
    appName: "Kothora Code",
    taskPromptLabel: "Task prompt",
    taskPromptPlaceholder: "Describe a coding task…",
    startTask: "Start task",
    cancelTask: "Cancel",
    selectWorkspace: "Select workspace",
    workspaceFilesLabel: "Workspace files",
    changedFilesLabel: "Changed files",
    workspaceHeading: "Workspace",
    changesHeading: "Changes",
    selectFileHeading: "Select a file",
    ready: "Ready",
    loadingWorkspace: "Loading workspace…",
    taskRunning: "Task is running",
    taskComplete: "Task complete",
    taskCancelled: "Task cancelled",
    taskFailed: "Task failed",
    taskStatus: "Task {status}",
    taskPollingTimedOut: "Task status polling timed out",
    errorStatus: "Error: {message}",
    noWorkspaceFiles: "No workspace files",
    noChangedFiles: "No changed files",
    fileHeading: "File: {path}",
    diffHeading: "Diff: {path}",
    changeCount: "{additions} additions, {deletions} deletions",
    loadingContent: "Loading content…",
    contentLoadError: "Content could not be loaded.",
    emptyFile: "This file is empty.",
    selectReviewItem: "Choose a workspace file or changed file to review it.",
    unexpectedError: "Something went wrong",
  },
  bn: {
    appName: "কথোরা কোড",
    taskPromptLabel: "কাজের নির্দেশনা",
    taskPromptPlaceholder: "আপনি যে কোডিং কাজটি করতে চান তা লিখুন…",
    startTask: "কাজ শুরু করুন",
    cancelTask: "বাতিল করুন",
    selectWorkspace: "ওয়ার্কস্পেস বাছুন",
    workspaceFilesLabel: "ওয়ার্কস্পেসের ফাইলসমূহ",
    changedFilesLabel: "পরিবর্তিত ফাইলসমূহ",
    workspaceHeading: "ওয়ার্কস্পেস",
    changesHeading: "পরিবর্তনসমূহ",
    selectFileHeading: "একটি ফাইল নির্বাচন করুন",
    ready: "প্রস্তুত",
    loadingWorkspace: "ওয়ার্কস্পেস লোড হচ্ছে…",
    taskRunning: "আপনার কাজটি চলছে",
    taskComplete: "আপনার কাজটি সম্পন্ন হয়েছে",
    taskCancelled: "আপনার কাজটি বাতিল করা হয়েছে",
    taskFailed: "আপনার কাজটি সম্পন্ন করা যায়নি",
    taskStatus: "কাজের অবস্থা: {status}",
    taskPollingTimedOut: "কাজের অবস্থা জানতে সময়সীমা শেষ হয়েছে",
    errorStatus: "ত্রুটি: {message}",
    noWorkspaceFiles: "ওয়ার্কস্পেসে কোনো ফাইল নেই",
    noChangedFiles: "কোনো পরিবর্তিত ফাইল নেই",
    fileHeading: "ফাইল: {path}",
    diffHeading: "পার্থক্য: {path}",
    changeCount: "{additions}টি সংযোজন, {deletions}টি বিয়োজন",
    loadingContent: "বিষয়বস্তু লোড হচ্ছে…",
    contentLoadError: "বিষয়বস্তু লোড করা যায়নি।",
    emptyFile: "এই ফাইলটি খালি।",
    selectReviewItem: "পর্যালোচনার জন্য আপনি একটি ওয়ার্কস্পেস ফাইল বা পরিবর্তিত ফাইল নির্বাচন করুন।",
    unexpectedError: "একটি অনাকাঙ্ক্ষিত সমস্যা হয়েছে",
  },
} as const satisfies Readonly<Record<Locale, MessageCatalog>>

export function selectLocale(preference?: string | null): Locale {
  if (!preference) return "en"
  const normalized = preference.trim().toLowerCase().replace("_", "-")
  return normalized === "bn" || normalized.startsWith("bn-") ? "bn" : "en"
}

export function interpolate(template: string, values: InterpolationValues = {}): string {
  return template.replace(/\{([a-z][a-z0-9]*)\}/gi, (token, key: string) =>
    Object.prototype.hasOwnProperty.call(values, key) ? String(values[key]) : token,
  )
}

export function translate(locale: Locale, key: MessageKey, values?: InterpolationValues): string {
  return interpolate(catalogs[locale]?.[key] ?? catalogs.en[key], values)
}
