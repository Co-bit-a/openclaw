import { describe, expect, expectTypeOf, it, vi } from "vitest";
import {
  validateConversationListParams,
  validateUiCommandParams,
  type ConversationListParams,
  type GatewayCoreRequestParams,
} from "../../../packages/gateway-protocol/src/index.js";
import { createPluginGatewayMethodDescriptor } from "../methods/descriptor.js";
import { createGatewayMethodRegistry } from "../methods/registry.js";
import { handleGatewayRequest } from "../server-methods.js";
import { SessionMutationAuthorizationChangedError } from "../session-sharing.js";
import type {
  GatewayRequestContext,
  GatewayRequestHandler,
  GatewayRequestHandlerOptions,
  RespondFn,
} from "./types.js";
import { defineValidatedGatewayMethod } from "./validation.js";

describe("typed gateway method validation", () => {
  it("binds core method names to their schema-derived payloads", async () => {
    expectTypeOf<
      GatewayCoreRequestParams["conversations.list"]
    >().toEqualTypeOf<ConversationListParams>();

    expectTypeOf(validateConversationListParams).toMatchTypeOf<
      Parameters<typeof defineValidatedGatewayMethod<"conversations.list">>[1]
    >();
    expectTypeOf(validateUiCommandParams).not.toMatchTypeOf<
      Parameters<typeof defineValidatedGatewayMethod<"conversations.list">>[1]
    >();

    const respond = vi.fn<RespondFn>();
    const handler = defineValidatedGatewayMethod(
      "conversations.list",
      validateConversationListParams,
      ({ params, respond: reply }) => {
        expectTypeOf(params).toEqualTypeOf<ConversationListParams>();
        reply(true, { agentId: params.agentId, limit: params.limit });
      },
    );
    const options: GatewayRequestHandlerOptions = {
      req: { type: "req", id: "typed-1", method: "conversations.list" },
      params: { agentId: "main", limit: 5 },
      client: null,
      isWebchatConnect: () => false,
      respond,
      context: {} as GatewayRequestContext,
    };

    await handler(options);

    expect(respond).toHaveBeenCalledWith(true, { agentId: "main", limit: 5 });
  });

  it("rejects malformed payloads before invoking the typed handler", async () => {
    const action = vi.fn();
    const respond = vi.fn<RespondFn>();
    const handler = defineValidatedGatewayMethod(
      "conversations.list",
      validateConversationListParams,
      action,
    );

    await handler({
      req: { type: "req", id: "typed-2", method: "conversations.list" },
      params: { agentId: "main", limit: "five" },
      client: null,
      isWebchatConnect: () => false,
      respond,
      context: {} as GatewayRequestContext,
    });

    expect(action).not.toHaveBeenCalled();
    expect(respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({
        code: "INVALID_REQUEST",
        message: expect.stringContaining("invalid conversations.list params"),
        requestEffect: "not_started",
      }),
    );
  });

  it("keeps post-dispatch authorization changes uncertain after durable work", async () => {
    const durableEffects: string[] = [];
    const changed = new SessionMutationAuthorizationChangedError({
      code: "INVALID_REQUEST",
      message: "session changed after durable work",
    });
    const handler: GatewayRequestHandler = async () => {
      durableEffects.push("publication-requested");
      await Promise.resolve();
      throw changed;
    };
    const method = "workboard.cards.dispatch";
    const methodRegistry = createGatewayMethodRegistry([
      createPluginGatewayMethodDescriptor({
        pluginId: "workboard",
        name: method,
        handler,
        scope: "operator.write",
      }),
    ]);
    const respond = vi.fn();

    await handleGatewayRequest({
      req: { type: "req", id: "post-dispatch-auth", method },
      respond,
      client: {
        connId: "post-dispatch-auth",
        connect: {
          role: "operator",
          scopes: ["operator.write"],
          client: { id: "test", version: "1", platform: "test", mode: "test" },
          minProtocol: 1,
          maxProtocol: 1,
        },
      } as Parameters<typeof handleGatewayRequest>[0]["client"],
      isWebchatConnect: () => false,
      context: { logGateway: { warn: vi.fn() } } as unknown as GatewayRequestContext,
      methodRegistry,
    });

    expect(durableEffects).toEqual(["publication-requested"]);
    expect(respond).toHaveBeenCalledWith(false, undefined, changed.error);
    expect(respond.mock.calls[0]?.[2]).not.toHaveProperty("requestEffect");
  });
});
