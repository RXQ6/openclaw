/* @vitest-environment jsdom */
import { gatewayCredentialScope } from "@openclaw/gateway-client/browser";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createStorageMock } from "../test-helpers/storage.ts";
import {
  clearBootRecords,
  persistBootRecord,
  subscribeBootRecordChanges,
  type BootRecord,
} from "./boot-record.ts";
import { subscribeWarmBootConnection } from "./bootstrap-warm-boot.ts";
import { createGatewayStoreTestStore } from "./gateway-store.test-support.ts";

beforeEach(() => {
  vi.stubGlobal("localStorage", createStorageMock());
  vi.stubGlobal("sessionStorage", createStorageMock());
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
const record = (scope: string, recoveryScope = "account-a"): BootRecord => ({
  version: 2,
  authMethod: "trusted-proxy",
  credential: "",
  recoveryScope,
  scope,
  savedAt: Date.now(),
  profileId: "profile-a",
  agents: { defaultId: "main", mainKey: "main", scope: "per-sender", agents: [{ id: "main" }] },
  groups: [],
  sectionOrder: [],
});

it.each(["first save", "refresh", "different account", "removal"])(
  "handles peer %s against an already authenticated account",
  (operation) => {
    const { gateway, current } = createGatewayStoreTestStore();
    gateway.connect();
    const source = current();
    source.opts.onHello?.({
      type: "hello-ok",
      protocol: 1,
      auth: { role: "operator", scopes: [], method: "trusted-proxy", recoveryScope: "account-a" },
      snapshot: { presence: [{ instanceId: source.instanceId, user: { id: "profile-a" } }] },
    });
    const rejected = vi.fn();
    const stop = subscribeWarmBootConnection(gateway, undefined, rejected);
    const scope = gatewayCredentialScope(gateway.connection.gatewayUrl);
    const previous = record(scope);
    const next = operation === "different account" ? record(scope, "account-b") : record(scope);
    try {
      window.dispatchEvent(
        new StorageEvent("storage", {
          key: "openclaw.control.bootRecord.v1:" + scope,
          oldValue: operation === "first save" ? null : JSON.stringify(previous),
          newValue: operation === "removal" ? null : JSON.stringify(next),
        }),
      );
      const retires = operation === "different account" || operation === "removal";
      expect(gateway.snapshot.phase).toBe(retires ? "stopped" : "connected");
      expect(rejected).toHaveBeenCalledTimes(retires ? 1 : 0);
    } finally {
      stop();
      gateway.stop();
    }
  },
);

it.each(["local", "external"])(
  "isolates a throwing %s retirement observer without keeping boot access",
  (source) => {
    const scope = "ws://test.invalid";
    const key = "openclaw.control.bootRecord.v1:" + scope;
    localStorage.setItem(key, JSON.stringify(record(scope)));
    persistBootRecord(record(scope));
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const failed = subscribeBootRecordChanges(() => {
      throw new Error("synthetic observer failure");
    });
    const observed = vi.fn();
    const stop = subscribeBootRecordChanges(observed);
    try {
      if (source === "local") {
        expect(() => clearBootRecords(scope)).not.toThrow();
      } else {
        localStorage.removeItem(key);
        window.dispatchEvent(
          new StorageEvent("storage", {
            key,
            oldValue: JSON.stringify(record(scope)),
            newValue: null,
          }),
        );
      }
      window.dispatchEvent(new Event("pagehide"));
      expect(localStorage.getItem(key)).toBeNull();
      expect(observed).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ scope }));
      expect(error).toHaveBeenCalledOnce();
    } finally {
      failed();
      stop();
    }
  },
);
it("does not interrupt a cold concurrent connection or admit the peer's identity", () => {
  const { gateway } = createGatewayStoreTestStore();
  gateway.connect();
  const rejected = vi.fn();
  const stop = subscribeWarmBootConnection(gateway, undefined, rejected);
  const scope = gatewayCredentialScope(gateway.connection.gatewayUrl);
  try {
    window.dispatchEvent(
      new StorageEvent("storage", {
        key: "openclaw.control.bootRecord.v1:" + scope,
        oldValue: null,
        newValue: JSON.stringify(record(scope)),
      }),
    );
    expect(gateway.snapshot.phase).toBe("connecting");
    expect(gateway.snapshot.hello).toBeNull();
    expect(rejected).not.toHaveBeenCalled();
  } finally {
    stop();
    gateway.stop();
  }
});
