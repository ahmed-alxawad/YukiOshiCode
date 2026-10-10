import type { NotFoundError as StorageNotFoundError } from "@/storage/storage"
import type { Session } from "@/session/session"
import { Cause, Effect } from "effect"
import { Redact } from "@yukioshi/core/redact"
import { NamedError } from "@yukioshi/core/util/error"
import * as ApiError from "../errors"

export function mapStorageNotFound<A, R>(self: Effect.Effect<A, StorageNotFoundError, R>) {
  return self.pipe(Effect.mapError((error) => ApiError.notFound(error.message)))
}

export function mapBusy<A, R>(self: Effect.Effect<A, Session.BusyError, R>) {
  return self.pipe(
    Effect.catchTag("SessionBusyError", (error) =>
      Effect.fail(
        new ApiError.SessionBusyError({
          sessionID: error.sessionID,
          message: `Session is busy: ${error.sessionID}`,
        }),
      ),
    ),
  )
}

/**
 * The error published on the event stream when an async prompt fails. The cause can quote a provider
 * response, a config file or a command, so it is masked before any client sees it.
 */
export function failureEvent(cause: Cause.Cause<unknown>) {
  return Redact.maskDeep(new NamedError.Unknown({ message: Cause.pretty(cause) }).toObject())
}
