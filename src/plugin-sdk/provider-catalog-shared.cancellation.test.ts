import { AsyncLocalStorage } from "node:async_hooks";
import { setImmediate as nextTurn } from "node:timers/promises";
import { queryObjects } from "node:v8";
import { afterEach, describe, expect, it } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import {
  captureProviderCatalogExpiries,
  recordLiveCatalogExpiry,
  withProviderCatalogExpiry,
} from "../plugins/provider-catalog-expiry.js";
import {
  clearLiveCatalogCacheForTests,
  getCachedLiveCatalogValue,
} from "./provider-catalog-shared.js";

describe("live catalog consumer cancellation", () => {
  afterEach(() => clearLiveCatalogCacheForTests());

  it.each(["resolve", "reject"] as const)(
    "delivers a shared %s to active consumers",
    async (outcome) => {
      const pending = createDeferred<string>();
      const error = new Error("catalog failed");
      let loads = 0;
      const load = () => {
        loads += 1;
        return pending.promise;
      };
      const signals = [
        new AbortController().signal,
        new AbortController().signal,
        outcome === "resolve" ? undefined : new AbortController().signal,
      ];
      const values = signals.map((signal) =>
        getCachedLiveCatalogValue({ keyParts: [outcome], load, signal }),
      );
      const joined = Promise.allSettled(values);
      if (outcome === "resolve") {
        pending.resolve("catalog");
      } else {
        pending.reject(error);
      }
      expect(await joined).toEqual(
        Array.from({ length: 3 }, () =>
          outcome === "resolve"
            ? { status: "fulfilled", value: "catalog" }
            : { status: "rejected", reason: error },
        ),
      );
      expect(loads).toBe(1);
    },
  );

  it.each(["synchronous", "queued"] as const)(
    "preserves completion ordering against a %s abort",
    async (timing) => {
      const pending = createDeferred<string>();
      const controller = new AbortController();
      const reason = new Error("consumer closed");
      const params = { keyParts: [timing], load: () => pending.promise };
      const survivor = getCachedLiveCatalogValue(params);
      const consumer = getCachedLiveCatalogValue({ ...params, signal: controller.signal });
      const joined = Promise.allSettled([survivor, consumer]);
      pending.resolve("catalog");
      if (timing === "synchronous") {
        controller.abort(reason);
      } else {
        queueMicrotask(() => controller.abort(reason));
      }
      const results = await joined;
      expect(results[0]).toEqual({ status: "fulfilled", value: "catalog" });
      expect(results[1]).toEqual(
        timing === "synchronous"
          ? { status: "rejected", reason }
          : { status: "fulfilled", value: "catalog" },
      );
    },
  );

  it("keeps a warm value when its consumer aborts after reading starts", async () => {
    const params = { keyParts: ["warm"], load: async () => "catalog" };
    await getCachedLiveCatalogValue(params);
    const controller = new AbortController();
    const consumer = getCachedLiveCatalogValue({ ...params, signal: controller.signal });
    controller.abort(new Error("consumer closed"));
    await expect(consumer).resolves.toBe("catalog");
  });

  it("records shared completion expiry in each consumer's context", async () => {
    const pending = createDeferred<string>();
    const read = (expiry: number) =>
      captureProviderCatalogExpiries(() =>
        withProviderCatalogExpiry(
          () => {
            recordLiveCatalogExpiry(expiry);
            return getCachedLiveCatalogValue({
              keyParts: ["expiry"],
              load: () => pending.promise,
              signal: new AbortController().signal,
              ttlMs: 500,
              now: () => 0,
            });
          },
          () => ["provider"],
        ),
      );
    const first = read(100);
    const second = read(2_000);
    pending.resolve("catalog");
    const results = await Promise.all([first, second]);
    expect(results.map((result) => result.providerExpiries.get("provider"))).toEqual([100, 500]);
  });

  it("releases canceled joiners' reasons and contexts while a shared load stays pending", async () => {
    const pending = createDeferred<string>();
    const storage = new AsyncLocalStorage<{ marker: object }>();
    let loads = 0;
    let acquisition: AbortSignal | undefined;
    const params = {
      keyParts: ["retention"],
      load: (signal?: AbortSignal) => {
        loads += 1;
        acquisition = signal;
        return pending.promise;
      },
    };
    const survivor = getCachedLiveCatalogValue(params);
    async function cancelJoiner(mode: "reason" | "context") {
      const marker = { mode };
      const reference = new WeakRef(marker);
      const controller = new AbortController();
      const reason = mode === "reason" ? marker : new Error("consumer closed");
      const call = () => getCachedLiveCatalogValue({ ...params, signal: controller.signal });
      const consumer = mode === "context" ? storage.run({ marker }, call) : call();
      const joined = consumer.then(
        () => {
          throw new Error("canceled consumer resolved");
        },
        (error: unknown) => {
          if (error !== reason) {
            throw new Error("cancellation reason changed");
          }
        },
      );
      controller.abort(reason);
      await joined;
      return reference;
    }
    try {
      const context = await cancelJoiner("context");
      const reason = await cancelJoiner("reason");
      const control = new WeakRef({ unowned: true });
      // End the factory job before collection; dereferencing earlier would retain the markers.
      await nextTurn();
      queryObjects(WeakRef);
      expect(control.deref()).toBeUndefined();
      expect(reason.deref()).toBeUndefined();
      expect(context.deref()).toBeUndefined();
      expect(loads).toBe(1);
      expect(acquisition?.aborted).toBe(false);
    } finally {
      pending.resolve("catalog");
      await survivor;
      storage.disable();
    }
  });
});
