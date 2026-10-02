import type { Hooks } from "@yukioshi/plugin"

export type AuthHook = NonNullable<Hooks["auth"]>
export type AuthMethod = AuthHook["methods"][number]

export type AuthMethodEntry = {
  hook: AuthHook
  method: AuthMethod
}

/**
 * Collect every authentication method registered for a provider. Plugins are
 * loaded in priority order, so a later method with the same type and label
 * replaces the earlier implementation without hiding unrelated methods.
 */
export function authMethodEntries(hooks: readonly Hooks[], provider: string): AuthMethodEntry[] {
  const entries: AuthMethodEntry[] = []
  const indexes = new Map<string, number>()

  for (const hook of hooks) {
    if (hook.auth?.provider !== provider) continue
    for (const method of hook.auth.methods) {
      const key = `${method.type}\0${method.label.trim().toLowerCase()}`
      const previous = indexes.get(key)
      const entry = { hook: hook.auth, method }
      if (previous !== undefined) {
        entries[previous] = entry
        continue
      }
      indexes.set(key, entries.length)
      entries.push(entry)
    }
  }

  return entries
}

export function authProviders(hooks: readonly Hooks[]): string[] {
  return [...new Set(hooks.flatMap((hook) => (hook.auth ? [hook.auth.provider] : [])))]
}
