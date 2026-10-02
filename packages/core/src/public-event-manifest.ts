export * as PublicEventManifest from "./public-event-manifest"

import { Event } from "@yukioshi/schema/event"
import { EventManifest } from "@yukioshi/schema/event-manifest"

export const Definitions = EventManifest.ServerDefinitions
export const Latest = Event.latest(Definitions)
