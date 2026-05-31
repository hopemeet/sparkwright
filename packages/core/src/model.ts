// AI maintenance note: ModelAdapter helpers — fallback chains, routing, and
// abort signal wiring. Add new adapter shapes via composition, not by
// editing core ModelAdapter. Provider implementations live in
// packages/provider-ai-sdk and adjacent packages.

import type {
  ModelAdapter,
  ModelInput,
  ModelOutput,
  ModelOutputChunk,
} from "./types.js";

export interface NamedModelAdapter {
  id: string;
  adapter: ModelAdapter;
}

export interface ModelRoute {
  id: string;
  when(input: ModelInput): boolean | Promise<boolean>;
  adapter: ModelAdapter;
}

export interface FallbackModelAdapterOptions {
  onFailure?: (input: {
    adapterId: string;
    attempt: number;
    error: unknown;
  }) => void;
}

export interface RoutingModelAdapterOptions {
  fallback?: ModelAdapter;
}

export interface AbortableModelAdapterOptions {
  signal?: AbortSignal;
  getSignal?: () => AbortSignal | undefined;
}

export function createFallbackModelAdapter(
  adapters: NamedModelAdapter[],
  options: FallbackModelAdapterOptions = {},
): ModelAdapter {
  if (adapters.length === 0) {
    throw new Error("Fallback model adapter requires at least one adapter.");
  }

  return {
    contextHints: adapters[0]?.adapter.contextHints,
    async complete(input): Promise<ModelOutput> {
      let lastError: unknown;

      for (let index = 0; index < adapters.length; index += 1) {
        const candidate = adapters[index];
        try {
          return await candidate.adapter.complete(input);
        } catch (error) {
          lastError = error;
          options.onFailure?.({
            adapterId: candidate.id,
            attempt: index + 1,
            error,
          });
        }
      }

      throw lastError instanceof Error
        ? lastError
        : new Error("All fallback model adapters failed.");
    },
    stream: adapters.some((candidate) => candidate.adapter.stream)
      ? async function* stream(input): AsyncIterable<ModelOutputChunk> {
          let lastError: unknown;

          for (let index = 0; index < adapters.length; index += 1) {
            const candidate = adapters[index];
            if (!candidate.adapter.stream) continue;

            try {
              yield* candidate.adapter.stream(input);
              return;
            } catch (error) {
              lastError = error;
              options.onFailure?.({
                adapterId: candidate.id,
                attempt: index + 1,
                error,
              });
            }
          }

          throw lastError instanceof Error
            ? lastError
            : new Error("All streaming fallback model adapters failed.");
        }
      : undefined,
  };
}

export function createRoutingModelAdapter(
  routes: ModelRoute[],
  options: RoutingModelAdapterOptions = {},
): ModelAdapter {
  return {
    async complete(input): Promise<ModelOutput> {
      const route = await selectRoute(routes, input);
      if (route) return route.adapter.complete(input);
      if (options.fallback) return options.fallback.complete(input);
      throw new Error("No model route matched the input.");
    },
    async *stream(input): AsyncIterable<ModelOutputChunk> {
      const route = await selectRoute(routes, input);
      const adapter = route?.adapter ?? options.fallback;
      if (!adapter) throw new Error("No model route matched the input.");
      if (!adapter.stream) {
        throw new Error("Selected model route does not support streaming.");
      }
      yield* adapter.stream(input);
    },
  };
}

export function createAbortableModelAdapter(
  adapter: ModelAdapter,
  options: AbortableModelAdapterOptions,
): ModelAdapter {
  return {
    contextHints: adapter.contextHints,
    async complete(input): Promise<ModelOutput> {
      const signal = currentSignal(options);
      throwIfAborted(signal);
      return raceAbort(adapter.complete(input), signal);
    },
    stream: adapter.stream
      ? async function* stream(input): AsyncIterable<ModelOutputChunk> {
          const signal = currentSignal(options);
          throwIfAborted(signal);

          for await (const chunk of adapter.stream!(input)) {
            throwIfAborted(signal);
            yield chunk;
          }
        }
      : undefined,
  };
}

async function selectRoute(
  routes: ModelRoute[],
  input: ModelInput,
): Promise<ModelRoute | undefined> {
  for (const route of routes) {
    if (await route.when(input)) return route;
  }
  return undefined;
}

function currentSignal(
  options: AbortableModelAdapterOptions,
): AbortSignal | undefined {
  return options.getSignal ? options.getSignal() : options.signal;
}

async function raceAbort<T>(
  promise: Promise<T>,
  signal: AbortSignal | undefined,
): Promise<T> {
  if (!signal) return promise;

  return Promise.race([
    promise,
    new Promise<never>((_, reject) => {
      const onAbort = () => reject(createAbortError());
      signal.addEventListener("abort", onAbort, { once: true });
      promise.finally(() => signal.removeEventListener("abort", onAbort));
    }),
  ]);
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw createAbortError();
}

function createAbortError(): Error {
  const error = new Error("Model operation aborted.");
  error.name = "AbortError";
  return error;
}
