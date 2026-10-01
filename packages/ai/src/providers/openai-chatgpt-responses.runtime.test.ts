import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WebSocket, WebSocketServer } from "ws";
import {
  configureAiTransportHost,
  createAiTransportHost,
  runWithAiTransportHost,
} from "../host.js";
import type { Context, Model } from "../types.js";
import {
  closeOpenAICodexWebSocketSessions,
  resetOpenAICodexWebSocketStateForTest,
  streamOpenAICodexResponses,
} from "./openai-chatgpt-responses.js";

const model = {
  id: "gpt-5.5",
  name: "GPT-5.5",
  api: "openai-chatgpt-responses",
  provider: "openai",
  baseUrl: "https://chatgpt.test/backend-api",
  reasoning: true,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 128_000,
  maxTokens: 16_000,
} satisfies Model<"openai-chatgpt-responses">;

const context = {
  messages: [{ role: "user", content: "hi", timestamp: 1 }],
} satisfies Context;

function createJwt(): string {
  const encode = (value: object) => Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${encode({ alg: "none", typ: "JWT" })}.${encode({
    "https://api.openai.com/auth": { chatgpt_account_id: "acct-1" },
  })}.signature`;
}

function completion(responseId: string) {
  return {
    type: "response.completed",
    response: {
      id: responseId,
      status: "completed",
      output: [],
      usage: { input_tokens: 5, output_tokens: 3, total_tokens: 8 },
    },
  };
}

describe("ChatGPT Responses runtime transport ownership", () => {
  afterEach(() => {
    closeOpenAICodexWebSocketSessions();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    resetOpenAICodexWebSocketStateForTest();
    configureAiTransportHost({});
  });

  it("does not reuse or clean up an authenticated socket across runtime hosts", async () => {
    const sessionId = "runtime-authority-isolation";
    const firstToken = createJwt();
    const secondToken = `${createJwt()}-other`;
    const received: Array<{ authorization?: string; connectionId: number }> = [];
    const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
    let connectionCount = 0;
    server.on("connection", (socket, request) => {
      const connectionId = ++connectionCount;
      socket.on("message", () => {
        received.push({ authorization: request.headers.authorization, connectionId });
        socket.send(JSON.stringify(completion(`resp_${connectionId}`)));
      });
    });
    await once(server, "listening");
    vi.stubGlobal("WebSocket", WebSocket);
    const loopbackModel = {
      ...model,
      baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}/backend-api`,
    } satisfies Model<"openai-chatgpt-responses">;
    const options = { apiKey: "opaque", sessionId, transport: "websocket-cached" as const };
    const firstHost = createAiTransportHost({
      resolveSecretSentinel: (value) => (value === "opaque" ? firstToken : value),
    });
    const secondHost = createAiTransportHost({
      resolveSecretSentinel: (value) => (value === "opaque" ? secondToken : value),
    });

    try {
      await runWithAiTransportHost(firstHost, () =>
        streamOpenAICodexResponses(loopbackModel, context, options).result(),
      );
      await runWithAiTransportHost(secondHost, () =>
        streamOpenAICodexResponses(loopbackModel, context, options).result(),
      );
      runWithAiTransportHost(firstHost, () => closeOpenAICodexWebSocketSessions(sessionId));
      await runWithAiTransportHost(secondHost, () =>
        streamOpenAICodexResponses(loopbackModel, context, options).result(),
      );

      expect(received).toEqual([
        { authorization: `Bearer ${firstToken}`, connectionId: 1 },
        { authorization: `Bearer ${secondToken}`, connectionId: 2 },
        { authorization: `Bearer ${secondToken}`, connectionId: 2 },
      ]);
    } finally {
      runWithAiTransportHost(firstHost, () => closeOpenAICodexWebSocketSessions(sessionId));
      runWithAiTransportHost(secondHost, () => closeOpenAICodexWebSocketSessions(sessionId));
      for (const socket of server.clients) {
        socket.terminate();
      }
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }
  });

  it("keeps default-host socket state reachable when replaced during payload construction", async () => {
    const sessionId = "default-host-replacement";
    const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
    server.on("connection", (socket) => {
      socket.on("message", () => {
        socket.send(JSON.stringify(completion("resp_default")));
      });
    });
    await once(server, "listening");
    vi.stubGlobal("WebSocket", WebSocket);
    const closeSpy = vi.spyOn(WebSocket.prototype, "close");
    const loopbackModel = {
      ...model,
      baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}/backend-api`,
    } satisfies Model<"openai-chatgpt-responses">;

    try {
      configureAiTransportHost({ resolveSecretSentinel: () => createJwt() });
      await streamOpenAICodexResponses(loopbackModel, context, {
        apiKey: "opaque",
        sessionId,
        transport: "websocket-cached",
        onPayload: (body) => {
          configureAiTransportHost({ resolveSecretSentinel: () => createJwt() });
          return body;
        },
      }).result();

      closeOpenAICodexWebSocketSessions(sessionId);

      expect(closeSpy).toHaveBeenCalledWith(1000, "debug_close");
    } finally {
      closeOpenAICodexWebSocketSessions(sessionId);
      for (const socket of server.clients) {
        socket.terminate();
      }
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }
  });

  it("keeps managed fetch and credentials on one host during payload construction", async () => {
    const firstToken = createJwt();
    let firstRequestHeaders: HeadersInit | undefined;
    const firstFetch = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      firstRequestHeaders = init?.headers;
      return new Response(`data: ${JSON.stringify(completion("resp_first"))}\n\n`, {
        headers: { "content-type": "text/event-stream" },
      });
    });
    const secondFetch = vi.fn(
      async () =>
        new Response(`data: ${JSON.stringify(completion("resp_second"))}\n\n`, {
          headers: { "content-type": "text/event-stream" },
        }),
    );
    configureAiTransportHost({
      buildModelFetch: () => firstFetch,
      requiresManagedTransport: () => true,
      resolveSecretSentinel: (value) => (value === "opaque" ? firstToken : value),
    });

    await streamOpenAICodexResponses(model, context, {
      apiKey: "opaque",
      transport: "auto",
      onPayload: (body) => {
        configureAiTransportHost({
          buildModelFetch: () => secondFetch,
          requiresManagedTransport: () => true,
        });
        return body;
      },
    }).result();

    expect(firstFetch).toHaveBeenCalledOnce();
    expect(secondFetch).not.toHaveBeenCalled();
    expect(new Headers(firstRequestHeaders).get("authorization")).toBe(`Bearer ${firstToken}`);
  });

  it.each(["auto", "websocket-cached"] as const)(
    "uses the managed fetch instead of opening a WebSocket for %s transport",
    async (transport) => {
      const managedFetch = vi.fn(
        async () =>
          new Response(`data: ${JSON.stringify(completion("resp_managed"))}\n\n`, {
            headers: { "content-type": "text/event-stream" },
          }),
      );
      const host = createAiTransportHost({
        buildModelFetch: () => managedFetch,
        requiresManagedTransport: () => true,
      });
      const WebSocketFixture = vi.fn(() => {
        throw new Error("managed transport must not open a WebSocket");
      });
      vi.stubGlobal("WebSocket", WebSocketFixture);

      const result = await runWithAiTransportHost(host, () =>
        streamOpenAICodexResponses(model, context, {
          apiKey: createJwt(),
          sessionId: `managed-${transport}`,
          transport,
        }).result(),
      );

      expect(result.stopReason).toBe("stop");
      expect(managedFetch).toHaveBeenCalledOnce();
      expect(WebSocketFixture).not.toHaveBeenCalled();
    },
  );
});
