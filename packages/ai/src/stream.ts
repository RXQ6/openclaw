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
import {
  bindAssistantMessageEventStream,
  getEventStreamCompletion,
} from "@openclaw/llm-core/event-stream";
import { createApiRegistry, type ApiRegistry } from "./api-registry.js";
import {
  createAiTransportHost,
  getDefaultAiTransportHost,
  runWithAiTransportHost,
  supportsScopedAiTransportHosts,
  type AiTransportHost,
} from "./host.js";
import {
  cleanupSessionResources as cleanupRegisteredSessionResources,
  registerSessionResourceCleanupObserver,
} from "./session-resources.js";

type ActiveAiTransportHost = ReturnType<typeof getDefaultAiTransportHost>;
type DefaultHostsBySession = Map<string | undefined, Set<ActiveAiTransportHost>>;

const defaultHostSessionReferences = new Set<WeakRef<DefaultHostsBySession>>();
const defaultHostSessionFinalizer = new FinalizationRegistry<WeakRef<DefaultHostsBySession>>(
  (reference) => defaultHostSessionReferences.delete(reference),
);

function trackDefaultHostSessions(sessions: DefaultHostsBySession): void {
  const reference = new WeakRef(sessions);
  defaultHostSessionReferences.add(reference);
  defaultHostSessionFinalizer.register(sessions, reference, reference);
}

registerSessionResourceCleanupObserver((sessionId, owner) => {
  for (const reference of defaultHostSessionReferences) {
    const sessions = reference.deref();
    if (!sessions) {
      defaultHostSessionReferences.delete(reference);
      continue;
    }
    const pruneOwners = (owners: Set<ActiveAiTransportHost>) => {
      if (owner) {
        owners.delete(owner);
      } else {
        owners.clear();
      }
      return owners.size === 0;
    };
    if (sessionId) {
      const owners = sessions.get(sessionId);
      if (owners && pruneOwners(owners)) {
        sessions.delete(sessionId);
      }
      continue;
    }
    for (const [ownedSessionId, owners] of sessions) {
      if (pruneOwners(owners)) {
        sessions.delete(ownedSessionId);
      }
    }
  }
});

function retainUnscopedStreamLifetime(
  stream: AssistantMessageEventStreamContract,
  runWithHost: <T>(operation: () => T) => T,
): AssistantMessageEventStreamContract {
  let releaseLifetime!: () => void;
  const lifetime = new Promise<void>((resolve) => {
    releaseLifetime = resolve;
  });
  void runWithHost(() => lifetime);
  let released = false;
  const release = () => {
    if (!released) {
      released = true;
      releaseLifetime();
    }
  };
  const result = stream.result.bind(stream);
  let resultPromise: ReturnType<typeof result> | undefined;
  const observeResult = () => {
    if (!resultPromise) {
      try {
        resultPromise = result();
      } catch (error) {
        resultPromise = Promise.reject(new Error("Stream result failed", { cause: error }));
      }
      void resultPromise.then(release, release);
    }
    return resultPromise;
  };
  const iterate = stream[Symbol.asyncIterator].bind(stream);
  return {
    push: stream.push.bind(stream),
    end: stream.end.bind(stream),
    result: observeResult,
    [Symbol.asyncIterator]() {
      const iterator = iterate();
      const finish = iterator.return?.bind(iterator);
      const fail = iterator.throw?.bind(iterator);
      return {
        [Symbol.asyncIterator]() {
          return this;
        },
        async next(...args) {
          try {
            const next = await iterator.next(...args);
            if (next.done) {
              void observeResult();
            }
            return next;
          } catch (error) {
            void observeResult();
            throw error;
          }
        },
        async return(value?: unknown) {
          try {
            return finish ? await finish(value) : { done: true as const, value };
          } finally {
            void observeResult();
          }
        },
        ...(fail
          ? {
              async throw(error?: unknown) {
                try {
                  return await fail(error);
                } finally {
                  void observeResult();
                }
              },
            }
          : {}),
      };
    },
  };
}

function createRuntime(registry: ApiRegistry, transportHost?: Partial<AiTransportHost>) {
  const explicitHost =
    transportHost === undefined ? undefined : createAiTransportHost(transportHost);
  const defaultHostsBySession = new Map<string | undefined, Set<ActiveAiTransportHost>>();
  if (!explicitHost) {
    trackDefaultHostSessions(defaultHostsBySession);
  }
  const resolveRuntimeHost = () => explicitHost ?? getDefaultAiTransportHost();
  const runWithHost = <T>(host: ActiveAiTransportHost, operation: () => T): T => {
    // A normal runtime uses its current embedding owner, even when invoked from
    // another runtime's callback. Do not capture the default during construction.
    return runWithAiTransportHost(host, operation);
  };
  const startStream = (
    start: () => AssistantMessageEventStreamContract,
    sessionId?: string,
  ): AssistantMessageEventStreamContract => {
    const host = resolveRuntimeHost();
    if (!explicitHost) {
      const hosts = defaultHostsBySession.get(sessionId) ?? new Set<ActiveAiTransportHost>();
      hosts.add(host);
      defaultHostsBySession.set(sessionId, hosts);
    }
    const runWithStreamHost = <T>(operation: () => T): T => runWithHost(host, operation);
    const started = runWithStreamHost(start);
    const completion = getEventStreamCompletion(started);
    const bound = bindAssistantMessageEventStream(started, runWithStreamHost);
    if (completion) {
      if (!supportsScopedAiTransportHosts()) {
        let producerSettled = false;
        const observedCompletion = completion.then(
          () => {
            producerSettled = true;
          },
          (error: unknown) => {
            producerSettled = true;
            throw error;
          },
        );
        void runWithStreamHost(() => observedCompletion);
        const result = runWithStreamHost(() => started.result());
        return bindAssistantMessageEventStream(
          started,
          (operation) => (producerSettled ? operation() : runWithStreamHost(operation)),
          {
            result: () => result,
          },
        );
      }
      void runWithStreamHost(() => completion);
    }
    return !completion && !supportsScopedAiTransportHosts()
      ? retainUnscopedStreamLifetime(bound, runWithStreamHost)
      : bound;
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
    return startStream(
      () => resolveApiProvider(model.api).stream(model, context, options as StreamOptions),
      options?.sessionId,
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
    return startStream(
      () => resolveApiProvider(model.api).streamSimple(model, context, options),
      options?.sessionId,
    );
  }

  async function completeSimple<TApi extends Api>(
    model: Model<TApi>,
    context: Context,
    options?: SimpleStreamOptions,
  ): Promise<AssistantMessage> {
    return streamSimple(model, context, options).result();
  }

  function cleanupSessionResources(sessionId?: string): void {
    if (!supportsScopedAiTransportHosts()) {
      cleanupRegisteredSessionResources(sessionId);
      return;
    }
    const usedHosts = new Set<ActiveAiTransportHost>();
    if (!explicitHost) {
      if (sessionId) {
        for (const host of defaultHostsBySession.get(sessionId) ?? []) {
          usedHosts.add(host);
        }
      } else {
        for (const owners of defaultHostsBySession.values()) {
          for (const host of owners) {
            usedHosts.add(host);
          }
        }
      }
      usedHosts.add(getDefaultAiTransportHost());
    }
    const hosts = explicitHost ? [explicitHost] : [...usedHosts];
    const errors: unknown[] = [];
    for (const host of hosts) {
      try {
        runWithHost(host, () => cleanupRegisteredSessionResources(sessionId, host));
      } catch (error) {
        errors.push(error);
      }
    }
    if (errors.length > 0) {
      throw new AggregateError(errors, "Failed to cleanup runtime session resources");
    }
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
