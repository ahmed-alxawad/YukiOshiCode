import { expect, test } from "bun:test"
import { Schema } from "effect"
import { AgentV2 } from "@yukioshi/core/agent"
import { Location as CoreLocation } from "@yukioshi/core/location"
import { ModelV2 } from "@yukioshi/core/model"
import { SessionV2 } from "@yukioshi/core/session"
import { SessionInput as CoreSessionInput } from "@yukioshi/core/session/input"
import { SessionMessage as CoreSessionMessage } from "@yukioshi/core/session/message"
import { Prompt as CorePrompt } from "@yukioshi/core/session/prompt"
import { Agent } from "@yukioshi/schema/agent"
import { Location } from "@yukioshi/schema/location"
import { Model } from "@yukioshi/schema/model"
import { Project } from "@yukioshi/schema/project"
import { Provider } from "@yukioshi/schema/provider"
import { Prompt } from "@yukioshi/schema/prompt"
import { Session } from "@yukioshi/schema/session"
import { SessionInput } from "@yukioshi/schema/session-input"
import { SessionMessage } from "@yukioshi/schema/session-message"
import { Workspace } from "@yukioshi/schema/workspace"
import { Api } from "@yukioshi/server/api"
import { compile, emitPromise } from "@yukioshi/httpapi-codegen"
import { ClientApi, endpointNames, groupNames, omitEndpoints } from "../src/contract"

test("Core and Server reuse the authoritative Schema and Protocol values", () => {
  expect(AgentV2.ID).toBe(Agent.ID)
  expect(CoreLocation.Ref).toBe(Location.Ref)
  expect(ModelV2.Ref).toBe(Model.Ref)
  expect(SessionV2.Info).toBe(Session.Info)
  expect(CoreSessionInput.Admitted).toBe(SessionInput.Admitted)
  expect(CoreSessionMessage.Message).toBe(SessionMessage.Message)
  expect(CorePrompt).toBe(Prompt)
  expect(Api.groups["server.session"].identifier).toBe("server.session")
  expect(Object.keys(ClientApi.groups)).toEqual(Object.keys(Api.groups))
  expect(Session.ID.create()).toStartWith("ses_")
  expect(Project.ID.global).toBe("global")
  expect(Provider.ID.anthropic).toBe("anthropic")
  expect(Workspace.ID.create()).toStartWith("wrk_")
})

test("client and Server contracts generate identically", () => {
  const server = compile(Api, { groupNames, endpointNames, omitEndpoints })
  const client = compile(ClientApi, { groupNames, endpointNames, omitEndpoints })

  expect(emitPromise(client)).toEqual(emitPromise(server))
})

test("shared DTO schemas construct and decode plain objects", () => {
  const made = Prompt.make({ text: "hello" })
  const decoded = Schema.decodeUnknownSync(Prompt)({ text: "hello" })
  const content = Schema.decodeUnknownSync(SessionMessage.AssistantText)({ type: "text", id: "part_1", text: "hi" })

  expect(Object.getPrototypeOf(made)).toBe(Object.prototype)
  expect(Object.getPrototypeOf(decoded)).toBe(Object.prototype)
  expect(Object.getPrototypeOf(content)).toBe(Object.prototype)
  expect(Prompt.ast.annotations?.identifier).toBe("Prompt")
  expect(SessionMessage.AssistantText.ast.annotations?.identifier).toBe("Session.Message.Assistant.Text")
  expect(CoreSessionMessage.AssistantText).toBe(SessionMessage.AssistantText)
})
