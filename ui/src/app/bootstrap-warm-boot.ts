import { gatewayCredentialScope } from "@openclaw/gateway-client/browser";
import { parseAgentSessionKey } from "../lib/sessions/session-key.ts";
import { clearCachedBootState } from "../lib/sessions/session-roster-cache.runtime.ts";
import { clearStoredChatSnapshots } from "../pages/chat/session-snapshot-invalidation.runtime.ts";
import { resolveChatSnapshotKey } from "../pages/chat/session-snapshot-key.ts";
import {
  markPrewarmedChatSnapshotReady,
  prewarmChatSnapshot,
} from "../pages/chat/session-snapshot-prewarm.ts";
import {
  clearBootRecords,
  subscribeBootRecordChanges,
  bootRecordAccountMatches,
  readOfflineStorageScope,
  persistBootRecord,
  resolveBootRecordAuth,
  type BootRecord,
} from "./boot-record.ts";
import type { ApplicationContext } from "./context.ts";
import type { ApplicationGateway } from "./gateway.ts";

export function prewarmBootChat(record: BootRecord, sessionKey: string): void {
  if (parseAgentSessionKey(sessionKey)) {
    prewarmChatSnapshot(
      resolveChatSnapshotKey(
        {
          agentsList: record.agents,
          hello: null,
          assistantAgentId: null,
          settings: { gatewayUrl: record.scope },
          client: { offlineRecoveryScope: record.recoveryScope },
        },
        { sessionKey },
      ),
    );
  }
}

export function clearWarmBootState(gatewayScope?: string, recoveryScope?: string): Promise<void> {
  // The boot record gates the next warm boot, so it must be gone before any
  // await: a reload during storage cleanup must fail closed.
  clearBootRecords(gatewayScope);
  const rosterCleared = clearCachedBootState(gatewayScope, recoveryScope);
  // Invalidate visible history and its cursor before pane subscribers resume startup.
  const snapshotsCleared = clearStoredChatSnapshots(
    gatewayScope
      ? recoveryScope
        ? `scope:${JSON.stringify([gatewayScope, recoveryScope])}\u0000`
        : `scope:[${JSON.stringify(gatewayScope)},`
      : undefined,
  );
  return Promise.all([rosterCleared, snapshotsCleared]).then(() => undefined);
}

export function subscribeWarmBootConnection(
  gateway: ApplicationGateway,
  profileId: string | null | undefined,
  onRejected: () => void,
  recoveryScope?: string,
): () => void {
  const bootConnectionRevision = gateway.connectionRevision;
  let pendingBootProfileId = profileId;
  let retainedScope = recoveryScope;
  const stopRetirement = subscribeBootRecordChanges(({ scope, external, replacement }) => {
    if (scope === undefined || scope === gatewayCredentialScope(gateway.connection.gatewayUrl)) {
      const snapshot = gateway.snapshot;
      const liveScope = snapshot.hello?.auth?.recoveryScope;
      const owner =
        liveScope ?? readOfflineStorageScope({ client: snapshot.client }) ?? retainedScope;
      if (
        bootRecordAccountMatches(
          replacement,
          owner,
          snapshot.selfUser?.id ?? pendingBootProfileId,
        ) ||
        (replacement && !owner && pendingBootProfileId === undefined)
      ) {
        return;
      }
      pendingBootProfileId = undefined;
      if (!liveScope || (retainedScope !== undefined && liveScope === retainedScope)) {
        gateway.snapshot.client?.retireOfflineRecoveryScope?.();
      }
      onRejected();
      if (external) {
        gateway.stop();
      }
    }
  });
  const stopConnection = gateway.subscribe((snapshot) => {
    if (snapshot.phase === "connected") {
      markPrewarmedChatSnapshotReady();
    }
    if (gateway.connectionRevision !== bootConnectionRevision) {
      pendingBootProfileId = undefined;
    }
    if (
      pendingBootProfileId !== undefined &&
      (snapshot.lastErrorAuthReason ||
        (typeof snapshot.lastErrorCode === "string" && snapshot.lastErrorCode !== "GATEWAY_BUSY"))
    ) {
      // A later transport failure cannot erase a rejected initial admission.
      // Retire this boot record, not drafts/outboxes or another Gateway’s cache.
      onRejected();
      clearBootRecords(gatewayCredentialScope(gateway.connection.gatewayUrl));
      pendingBootProfileId = undefined;
    }
    if (snapshot.phase !== "connected" || pendingBootProfileId === undefined) {
      return;
    }
    const scopeMismatch =
      retainedScope !== undefined && snapshot.hello?.auth?.recoveryScope !== retainedScope;
    const profileMismatch =
      retainedScope === undefined && pendingBootProfileId !== (snapshot.selfUser?.id ?? null);
    pendingBootProfileId = undefined;
    if (profileMismatch || scopeMismatch) {
      onRejected();
      void clearWarmBootState(gatewayCredentialScope(gateway.connection.gatewayUrl), retainedScope);
    }
    retainedScope = snapshot.hello?.auth?.recoveryScope;
  });
  return () => {
    stopRetirement();
    stopConnection();
  };
}

export function subscribeBootRecordPersistence({
  gateway,
  agents,
  sessions,
}: Pick<ApplicationContext, "gateway" | "agents" | "sessions">): () => void {
  const persistLiveBootRecord = () => {
    if (gateway.snapshot.phase !== "connected" || gateway.snapshot.client?.offlineRecoveryRetired) {
      return;
    }
    const scope = gatewayCredentialScope(gateway.connection.gatewayUrl);
    const auth = resolveBootRecordAuth(gateway.snapshot.hello?.auth, gateway.connection.token);
    if (!auth) {
      clearBootRecords(scope);
      return;
    }
    const agentsList = agents.state.agentsList;
    if (agentsList && !agents.state.agentsListCached && sessions.groupsStatus() === "ready") {
      persistBootRecord({
        version: 2,
        recoveryScope: gateway.snapshot.client?.recoveryScopeReady
          ? gateway.snapshot.client.recoveryScope
          : gateway.snapshot.hello?.auth?.recoveryScope,
        ...auth,
        savedAt: Date.now(),
        scope,
        profileId: gateway.snapshot.selfUser?.id ?? null,
        agents: agentsList,
        groups: [...sessions.state.groupSettings],
        sectionOrder: [...sessions.state.sectionOrder],
      });
    }
  };
  const stops = [gateway, agents, sessions].map((capability) =>
    capability.subscribe(persistLiveBootRecord),
  );
  return () => stops.forEach((stop) => stop());
}
