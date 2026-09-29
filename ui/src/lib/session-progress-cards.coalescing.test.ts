import { describe, expect, it, onTestFinished } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import {
  createGateway,
  createProgressCard,
  sessionKey,
} from "./session-progress-cards.test-support.ts";
import { sessionProgressCardsForGateway } from "./session-progress-cards.ts";

describe("session progress card coalescing ownership", () => {
  it.each([
    { cachedRevision: 1, queuedRevision: 3, revision: 3, absent: false, reads: 2 },
    { cachedRevision: 1, queuedRevision: 3, revision: 2, absent: false, reads: 3 },
    { cachedRevision: 1, queuedRevision: 3, revision: null, absent: false, reads: 3 },
    { cachedRevision: 1, queuedRevision: null, revision: null, absent: true, reads: 3 },
    { cachedRevision: 3, queuedRevision: 2, revision: null, absent: true, reads: 3 },
  ])(
    "coalesces reads without ending an overtaken lifetime (cached $cachedRevision, queued $queuedRevision, response $revision)",
    async ({ cachedRevision, queuedRevision, revision, absent, reads }) => {
      const { gateway, request, emitChange } = createGateway();
      const target = { sessionKey };
      const initial = { ...createProgressCard(1), revision: cachedRevision };
      const response = revision === null ? null : { ...initial, revision };
      const latest = absent ? null : { ...initial, revision: 4, markdown: "Latest" };
      const refresh = createDeferred<{ card: typeof response }>();
      const followUp = createDeferred<{ card: typeof latest }>();
      request
        .mockResolvedValueOnce({ card: initial })
        .mockReturnValueOnce(refresh.promise)
        .mockReturnValueOnce(followUp.promise);
      const store = sessionProgressCardsForGateway(gateway);
      const owner = {};
      store.watch(owner, [target]);
      const displayed = await store.load(target);
      const lifetime = store.getLifetime(target);
      expect(lifetime).toBeDefined();
      const publishedLifetimes: Array<object | undefined> = [];
      const unsubscribe = store.subscribe(() => publishedLifetimes.push(store.getLifetime(target)));
      onTestFinished(() => {
        unsubscribe();
        store.unwatch(owner);
        refresh.resolve({ card: response });
        followUp.resolve({ card: latest });
      });
      emitChange(sessionKey, cachedRevision + 1);
      const reading = store.load(target);
      emitChange(sessionKey, queuedRevision);
      emitChange(sessionKey, queuedRevision);
      expect(request).toHaveBeenCalledTimes(2);
      refresh.resolve({ card: response });
      await reading;
      expect(store.get(target)).toEqual(response ?? displayed);
      if (response === null) {
        expect(store.get(target)).toBe(displayed);
      }
      expect(store.getLifetime(target)).toBe(lifetime);
      expect(publishedLifetimes.every((token) => token === lifetime)).toBe(true);
      // Start automatically, even if the OLD cached revision satisfies the hint.
      expect(request).toHaveBeenCalledTimes(reads);
      if (reads === 3) {
        const confirming = store.load(target);
        followUp.resolve({ card: latest });
        await confirming;
        expect(store.get(target)).toEqual(latest);
        expect(store.getLifetime(target)).toBe(absent ? undefined : lifetime);
        expect(request).toHaveBeenCalledTimes(3);
      }
    },
  );
});
