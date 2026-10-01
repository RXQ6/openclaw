import { isIncognitoSessionKey } from "../../../../src/shared/incognito-session-key.js";
import { getSafeSessionStorage } from "../../local-storage.ts";
import { resolveUiConversationIdentity, hasUiSessionDefaults } from "../sessions/session-key.ts";
import {
  observeOutboxRecoveryOwner,
  outboxPayloadCanRecover,
} from "./outbox-payload-store.runtime.ts";
import { normalizeStoredSession } from "./outbox-store-codec.ts";
import { nextDraftRevision, readDraftRevisionState } from "./outbox-store-draft-state.ts";
import type { StoredChatOutboxScope } from "./outbox-store-scope.ts";
import {
  notifyStoredChatOutboxChanges,
  readStoredOutboxStore,
  resolvePendingComposerSessions,
  storedChatOutboxScopeKey,
  storageTargetForGateway,
  storageTargetForComposer,
  writeStoredOutboxStore,
  type ChatComposerScope,
  type StoredComposerRecovery,
} from "./outbox-store.ts";

export type ChatOutboxRecoveryEntry = StoredComposerRecovery & { id: string };
export type ChatOutboxRecoveryResult = "restored" | "conflict" | "storage-failed";

export function readChatOutboxRecovery(state: ChatComposerScope): {
  entries: ChatOutboxRecoveryEntry[];
  blocked: boolean;
} {
  const storage = getSafeSessionStorage();
  if (!storage) {
    throw new Error("Browser storage is unavailable");
  }
  const target = storageTargetForComposer(state);
  const store = readStoredOutboxStore(storage, target);
  // Legacy tab metadata has no account claim. Keep it in its original bucket
  // until an explicit review transfers a row; no login adopts or drains it.
  const legacy = target.recoveryScope
    ? readStoredOutboxStore(storage, storageTargetForGateway(state.settings?.gatewayUrl))
    : null;
  const recovery = { ...store.recovery };
  if (legacy) {
    for (const [key, session] of Object.entries(legacy.sessions)) {
      recovery["legacy-session:" + key] = { sourceVersion: 4, sourceScopeKey: key, session };
    }
    for (const [key, entry] of Object.entries(legacy.recovery)) {
      recovery["legacy-recovery:" + key] = entry;
    }
  }
  return {
    entries: Object.entries(recovery)
      .filter(([, entry]) =>
        (entry.session.queue ?? []).every((item) => outboxPayloadCanRecover(state, item)),
      )
      .map(([id, entry]) => Object.assign({}, entry, { id })),
    blocked: store.recoveryBlocked === true || legacy?.recoveryBlocked === true,
  };
}

export function captureChatOutboxRecoveryDestination(
  state: ChatComposerScope,
  scope: StoredChatOutboxScope,
) {
  const storage = getSafeSessionStorage();
  const recoveryScope = observeOutboxRecoveryOwner(state);
  if (
    !storage ||
    !recoveryScope ||
    !hasUiSessionDefaults(state) ||
    state.selectedChatSessionIncognito ||
    isIncognitoSessionKey(scope.sessionKey) ||
    (state.connected && state.client && !state.client.recoveryScopeReady)
  ) {
    return null;
  }
  const target = storageTargetForComposer(state);
  const store = readStoredOutboxStore(storage, target);
  resolvePendingComposerSessions(store, state);
  const storeSessionKey = storedChatOutboxScopeKey(
    resolveUiConversationIdentity(state, scope.sessionKey, scope.agentId),
  );
  const session = store.sessions[storeSessionKey] ?? null;
  return {
    scope,
    gatewayOwner: target.gatewayOwner,
    recoveryScope,
    session: JSON.stringify(session),
    revision: readDraftRevisionState(storage, target.key, storeSessionKey, session?.draftRevision)
      .latestAttempt,
  };
}

export function restoreChatOutboxRecovery(
  state: ChatComposerScope,
  entry: ChatOutboxRecoveryEntry,
  destination: NonNullable<ReturnType<typeof captureChatOutboxRecoveryDestination>>,
  minimumRevision = 0,
): ChatOutboxRecoveryResult {
  const storage = getSafeSessionStorage();
  if (!storage) {
    return "storage-failed";
  }
  try {
    const current = captureChatOutboxRecoveryDestination(state, destination.scope);
    if (!current || JSON.stringify(current) !== JSON.stringify(destination)) {
      return "conflict";
    }
    const target = storageTargetForComposer(state);
    const store = readStoredOutboxStore(storage, target);
    const { id, ...expected } = entry;
    const legacyTarget = storageTargetForGateway(state.settings?.gatewayUrl);
    const legacy = id.startsWith("legacy-") ? readStoredOutboxStore(storage, legacyTarget) : null;
    const sourceKey = id.slice(id.indexOf(":") + 1);
    const source = legacy
      ? id.startsWith("legacy-session:")
        ? { sourceVersion: 4, sourceScopeKey: sourceKey, session: legacy.sessions[sourceKey] }
        : legacy.recovery[sourceKey]
      : store.recovery[id];
    if (
      JSON.stringify(source) !== JSON.stringify(expected) ||
      !(entry.session.queue ?? []).every((item) => outboxPayloadCanRecover(state, item))
    ) {
      return "conflict";
    }
    const scope = resolveUiConversationIdentity(
      state,
      destination.scope.sessionKey,
      destination.scope.agentId,
    );
    if (storedChatOutboxScopeKey(scope) !== storedChatOutboxScopeKey(destination.scope)) {
      return "conflict";
    }
    const key = storedChatOutboxScopeKey(scope);
    const existing = store.sessions[key];
    if (existing?.draft || existing?.goalMode || existing?.replyTarget || existing?.queue?.length) {
      return "conflict";
    }
    const session = entry.session;
    store.sessions[key] = {
      ...session,
      awaitingDefaults: undefined,
      // Transfer is an operator edit, and must fence every older destination writer.
      draftRevision: nextDraftRevision(
        Math.max(minimumRevision, destination.revision, session.draftRevision ?? 0),
      ),
      queue: session.queue?.map((item) =>
        Object.assign({}, item, scope, {
          // Explicit review is the admission that assigns legacy input to this account.
          storageScope: JSON.stringify([destination.gatewayOwner, destination.recoveryScope]),
          sendState:
            item.sendState === "held"
              ? "held"
              : (item.sendAttempts ?? 0) > 0 || item.sendState === "unconfirmed"
                ? "unconfirmed"
                : "failed",
          sendError:
            item.sendError ??
            "Recovered message. Review this destination and retry only if it did not arrive.",
        }),
      ),
    };
    delete store.recovery[id];
    writeStoredOutboxStore(storage, target, store);
    const written = readStoredOutboxStore(storage, target);
    if (
      written.recovery[id] ||
      JSON.stringify(written.sessions[key]) !==
        JSON.stringify(normalizeStoredSession(store.sessions[key]))
    ) {
      return "storage-failed";
    }
    if (legacy) {
      // Destination is verified before retiring the complete original source.
      if (id.startsWith("legacy-session:")) {
        delete legacy.sessions[sourceKey];
      } else {
        delete legacy.recovery[sourceKey];
      }
      writeStoredOutboxStore(storage, legacyTarget, legacy);
    }
    notifyStoredChatOutboxChanges();
    return "restored";
  } catch {
    return "storage-failed";
  }
}
