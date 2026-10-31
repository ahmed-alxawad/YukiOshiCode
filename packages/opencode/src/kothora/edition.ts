/**
 * Kothora edition switch.
 *
 * The Kothora product spec runs this same codebase as a gateway-only client:
 * when the edition is ON, the only selectable provider is "kothora" (its models
 * are served through the Kothora gateway), bring-your-own-key login methods are
 * switched OFF, and device-code sign-in is provided by the kothora auth plugin.
 *
 * When the edition is OFF (the default) every code path here is a no-op and
 * YukiOshi behaviour is unchanged.
 *
 * The edition flag is read from the KOTHORA_EDITION environment variable
 * ("1" or "true"). The `kothora` bin wrapper sets it for its child process.
 * No secrets or private URLs belong in this repository.
 */

export const KOTHORA_EDITION_ENV = "KOTHORA_EDITION"

/** The single provider id the Kothora edition allows. */
export const KOTHORA_PROVIDER_ID = "kothora"

export function isKothoraEdition(): boolean {
  const value = process.env[KOTHORA_EDITION_ENV]
  return value === "1" || value === "true"
}

/**
 * Keep only the kothora provider when the edition is on; return the input
 * unchanged otherwise.
 */
export function filterProvidersForEdition<T extends { id: string }>(providers: T[]): T[] {
  if (!isKothoraEdition()) return providers
  return providers.filter((provider) => provider.id === KOTHORA_PROVIDER_ID)
}
