import { fileURLToPath } from "node:url";
import { runInNewContext } from "node:vm";
import { build } from "esbuild";
import { expect, it } from "vitest";

type BrowserHostModule = {
  configureAiTransportHost(host: object): void;
  createAssistantMessageEventStream(): {
    push(event: object): void;
    result(): Promise<unknown>;
  };
  createApiRegistry(): {
    registerApiProvider(provider: object): void;
  };
  createLlmRuntime(registry: object): {
    stream(
      model: object,
      context: object,
    ): {
      result(): Promise<unknown>;
      [Symbol.asyncIterator](): AsyncIterator<unknown>;
    };
  };
  getDefaultAiTransportHost(): unknown;
  runWithAiTransportHost<T>(host: unknown, run: () => T): T;
};

it("keeps the default transport host usable in browser bundles", async () => {
  const result = await build({
    stdin: {
      contents:
        'export * from "./index.ts"; export { createAssistantMessageEventStream } from "@openclaw/llm-core/event-stream";',
      resolveDir: fileURLToPath(new URL(".", import.meta.url)),
      sourcefile: "browser-host-entry.ts",
    },
    bundle: true,
    format: "iife",
    globalName: "OpenClawAiHost",
    logLevel: "silent",
    platform: "browser",
    write: false,
  });

  expect(result.errors).toEqual([]);
  const context: {
    OpenClawAiHost?: BrowserHostModule;
    TextDecoder: typeof TextDecoder;
    TextEncoder: typeof TextEncoder;
  } = {
    TextDecoder,
    TextEncoder,
  };
  runInNewContext(result.outputFiles[0]?.text ?? "", context);
  const browserHost = context.OpenClawAiHost;
  if (!browserHost) {
    throw new Error("browser bundle did not expose its host contract");
  }
  expect(
    browserHost.runWithAiTransportHost(browserHost.getDefaultAiTransportHost(), () => "ok"),
  ).toBe("ok");

  const final = { role: "assistant", content: [], stopReason: "stop" };
  const source = {
    push() {},
    end() {},
    async result() {
      return final;
    },
    async *[Symbol.asyncIterator]() {},
  };
  const registry = browserHost.createApiRegistry();
  registry.registerApiProvider({
    api: "browser-test",
    // The provider belongs to this test realm, not the browser VM realm.
    stream: () => source,
    streamSimple: () => source,
  });
  const runtime = browserHost.createLlmRuntime(registry);
  const stream = runtime.stream(
    { api: "browser-test", provider: "fixture", id: "browser" },
    { messages: [] },
  );
  expect(() => browserHost.configureAiTransportHost({})).toThrow(
    "Cannot replace the AI transport host while browser provider work is pending",
  );
  await expect(stream.result()).resolves.toBe(final);
  browserHost.configureAiTransportHost({});

  let releaseResult!: () => void;
  const resultGate = new Promise<void>((resolve) => {
    releaseResult = resolve;
  });
  const pendingSource = {
    ...source,
    async result() {
      await resultGate;
      return final;
    },
  };
  const pendingRegistry = browserHost.createApiRegistry();
  pendingRegistry.registerApiProvider({
    api: "browser-pending-test",
    stream: () => pendingSource,
    streamSimple: () => pendingSource,
  });
  const pendingStream = browserHost
    .createLlmRuntime(pendingRegistry)
    .stream(
      { api: "browser-pending-test", provider: "fixture", id: "browser-pending" },
      { messages: [] },
    );
  expect(await pendingStream[Symbol.asyncIterator]().next()).toEqual({
    done: true,
    value: undefined,
  });
  expect(() => browserHost.configureAiTransportHost({})).toThrow(
    "Cannot replace the AI transport host while browser provider work is pending",
  );
  releaseResult();
  await expect(pendingStream.result()).resolves.toBe(final);
  browserHost.configureAiTransportHost({});

  const nativeSource = browserHost.createAssistantMessageEventStream();
  const nativeRegistry = browserHost.createApiRegistry();
  nativeRegistry.registerApiProvider({
    api: "browser-native-test",
    stream: () => nativeSource,
    streamSimple: () => nativeSource,
  });
  const nativeStream = browserHost
    .createLlmRuntime(nativeRegistry)
    .stream(
      { api: "browser-native-test", provider: "fixture", id: "browser-native" },
      { messages: [] },
    );
  const delegatedRegistry = browserHost.createApiRegistry();
  delegatedRegistry.registerApiProvider({
    api: "browser-delegated-test",
    stream: () => nativeStream,
    streamSimple: () => nativeStream,
  });
  const delegatedStream = browserHost
    .createLlmRuntime(delegatedRegistry)
    .stream(
      { api: "browser-delegated-test", provider: "fixture", id: "browser-delegated" },
      { messages: [] },
    );
  expect(() => browserHost.configureAiTransportHost({})).toThrow(
    "Cannot replace the AI transport host while browser provider work is pending",
  );
  nativeSource.push({ type: "done", reason: "stop", message: final });
  await nativeSource.result();
  await Promise.resolve();
  browserHost.configureAiTransportHost({});
  await expect(nativeStream.result()).resolves.toBe(final);
  await expect(delegatedStream.result()).resolves.toBe(final);
});
