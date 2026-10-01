import type {
  Api,
  AssistantMessage,
  AssistantMessageEventStreamContract,
  Context,
  Model,
  ProviderStreamOptions,
  SimpleStreamOptions,
  StreamOptions,
} from "@openclaw/llm-core";
import { bindAssistantMessageEventStream } from "@openclaw/llm-core/event-stream";
import { createApiRegistry, type ApiRegistry } from "./api-registry.js";
import {
  createAiTransportHost,
  getDefaultAiTransportHost,
  runWithAiTransportHost,
  supportsScopedAiTransportHosts,
  type AiTransportHost,
} from "./host.js";
import { cleanupSessionResources as cleanupRegisteredSessionResources } from "./session-resources.js";

type ActiveAiTransportHost = ReturnType<typeof getDefaultAiTransportHost>;

function createRuntime(registry: ApiRegistry, transportHost?: Partial<AiTransportHost>) {
  const explicitHost =
    transportHost === undefined ? undefined : createAiTransportHost(transportHost);
  const resolveRuntimeHost = () => explicitHost ?? getDefaultAiTransportHost();
  const runWithHost = <T>(host: ActiveAiTransportHost, operation: () => T): T => {
    // A normal runtime uses its current embedding owner, even when invoked from
    // another runtime's callback. Do not capture the default during construction.
    return runWithAiTransportHost(
      explicitHost || supportsScopedAiTransportHosts() ? host : getDefaultAiTransportHost(),
      operation,
    );
  };
  const runWithRuntimeHost = <T>(operation: () => T): T =>
    runWithHost(resolveRuntimeHost(), operation);
  const startStream = (
    start: () => AssistantMessageEventStreamContract,
  ): AssistantMessageEventStreamContract => {
    const host = resolveRuntimeHost();
    const runWithStreamHost = <T>(operation: () => T): T => runWithHost(host, operation);
    const started = runWithStreamHost(start);
    return bindAssistantMessageEventStream(started, runWithStreamHost);
  };
  function resolveApiProvider(api: Api) {
    const provider = registry.getApiProvider(api);
    if (!provider) {
      throw new Error(`No API provider registered for api: ${api}`);
    }
    return provider;
  }

  function stream<TApi extends Api>(
    model: Model<TApi>,
    context: Context,
    options?: ProviderStreamOptions,
  ): AssistantMessageEventStreamContract {
    return startStream(() =>
      resolveApiProvider(model.api).stream(model, context, options as StreamOptions),
    );
  }

  async function complete<TApi extends Api>(
    model: Model<TApi>,
    context: Context,
    options?: ProviderStreamOptions,
  ): Promise<AssistantMessage> {
    return stream(model, context, options).result();
  }

  function streamSimple<TApi extends Api>(
    model: Model<TApi>,
    context: Context,
    options?: SimpleStreamOptions,
  ): AssistantMessageEventStreamContract {
    return startStream(() => resolveApiProvider(model.api).streamSimple(model, context, options));
  }

  async function completeSimple<TApi extends Api>(
    model: Model<TApi>,
    context: Context,
    options?: SimpleStreamOptions,
  ): Promise<AssistantMessage> {
    return streamSimple(model, context, options).result();
  }

  function cleanupSessionResources(sessionId?: string): void {
    runWithRuntimeHost(() => cleanupRegisteredSessionResources(sessionId));
  }

  return {
    registry,
    stream,
    complete,
    streamSimple,
    completeSimple,
    cleanupSessionResources,
  };
}

/** Creates an isolated LLM runtime backed by the supplied provider registry. */
export function createLlmRuntime(registry: ApiRegistry = createApiRegistry()) {
  return createRuntime(registry);
}

/** Creates a Node runtime whose provider work retains an explicit transport host. */
export function createNodeLlmRuntime(
  registry: ApiRegistry = createApiRegistry(),
  transportHost: Partial<AiTransportHost> = {},
) {
  if (!supportsScopedAiTransportHosts()) {
    throw new Error("Explicit AI transport hosts require Node.js async context support");
  }
  return createRuntime(registry, transportHost);
}

export type LlmRuntime = ReturnType<typeof createLlmRuntime>;
