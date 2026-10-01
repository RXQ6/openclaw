import type { WorkerOperations } from "../../state/worker-operation-registry.js";
import type { conversationBindingOperations } from "./current-conversation-bindings.worker.js";
import type { BindingTargetKind, ConversationRef } from "./session-binding.types.js";

export type CurrentConversationBindingTouch = {
  conversation: ConversationRef;
  bindingId: string;
  at: number;
  accountPolicy?: {
    idleTimeoutMs: number;
    maxAgeMs: number;
    targetKinds: Record<BindingTargetKind, BindingTargetKind>;
  };
};

export type CurrentConversationBindingWorkerOperations = WorkerOperations<
  typeof conversationBindingOperations
>;
