import { Effect } from "effect"
import { Edition } from "@yukioshi/core/edition"
import { openUrl } from "@yukioshi/core/open"
import { Auth } from "../../auth"
import { CliError, effectCmd, fail } from "../effect-cmd"
import { cmd } from "./cmd"
import { UI } from "../ui"
import { KothoraClient } from "../../kothora/client"
import { apiUrl } from "../../kothora/config"
import { authorize, formatMe, me, pollForTokens } from "../../kothora/device"
import { BYOK_REFUSED, KothoraError } from "../../kothora/errors"
import { clientFor } from "../../kothora/provider"
import { authTokenStore } from "../../kothora/tokens"

const run = <A>(fn: () => Promise<A>) =>
  Effect.tryPromise({
    try: fn,
    catch: (error) => error,
  }).pipe(
    Effect.catch((error) =>
      fail(error instanceof KothoraError ? error.userMessage : error instanceof Error ? error.message : String(error)),
    ),
  )

export const KothoraLoginCommand = effectCmd({
  command: "login",
  describe: "sign in to Kothora with your browser",
  instance: false,
  handler: Effect.fn("Cli.kothora.login")(function* () {
    const auth = yield* Auth.Service
    const store = authTokenStore(auth)
    // Sign-in uses its own client: there are no tokens yet, so none are sent.
    const client = new KothoraClient({ baseUrl: apiUrl(), store })
    const code = yield* run(() => authorize(client, { clientName: Edition.productName }))
    UI.println(`Your code: ${UI.Style.TEXT_HIGHLIGHT_BOLD}${code.user_code}${UI.Style.TEXT_NORMAL}`)
    UI.println(`Open ${code.verification_uri} and enter the code, or open ${code.verification_uri_complete}`)
    UI.println(`The code works for ${Math.round(code.expires_in / 60)} minutes.`)
    // Opening the browser is a convenience: when it fails the user still has the address above.
    yield* Effect.promise(() => openUrl(code.verification_uri_complete).catch(() => undefined))
    UI.println("Waiting for you to approve in the browser...")
    const tokens = yield* run(() =>
      pollForTokens(apiUrl(), code, { onNotice: (message) => UI.println(UI.Style.TEXT_DIM + message + UI.Style.TEXT_NORMAL) }),
    )
    yield* run(() => store.save(tokens))
    const info = yield* run(() => me(clientFor(store)))
    UI.println(UI.Style.TEXT_SUCCESS_BOLD + `Signed in as ${info.account.email}` + UI.Style.TEXT_NORMAL)
  }),
})

export const KothoraLogoutCommand = effectCmd({
  command: "logout",
  describe: "delete the Kothora sign-in from this device",
  instance: false,
  handler: Effect.fn("Cli.kothora.logout")(function* () {
    const auth = yield* Auth.Service
    yield* run(() => authTokenStore(auth).clear())
    UI.println("Signed out. The tokens on this device were deleted.")
  }),
})

export const KothoraWhoamiCommand = effectCmd({
  command: "whoami",
  describe: "show your Kothora account, plan and credits",
  instance: false,
  handler: Effect.fn("Cli.kothora.whoami")(function* () {
    const auth = yield* Auth.Service
    const info = yield* run(() => me(clientFor(authTokenStore(auth))))
    UI.println(formatMe(info))
  }),
})

/** In the Kothora edition `providers` is hidden and refuses with a clear message. */
export const RefusedProvidersCommand = cmd({
  command: "providers",
  aliases: ["auth"],
  describe: false,
  builder: (yargs) => yargs,
  async handler() {
    throw new CliError({ message: BYOK_REFUSED })
  },
})
