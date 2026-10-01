import type { OAuthDiscoveryState } from "@modelcontextprotocol/sdk/client/auth.js";
import type {
  OAuthClientInformationMixed,
  OAuthTokens,
} from "@modelcontextprotocol/sdk/shared/auth.js";
import type { WorkerOperations } from "../state/worker-operation-registry.js";
import type { mcpOAuthOperations } from "./mcp-oauth-store.worker.js";

type McpOAuthAuthorizationChallenge = {
  resourceMetadataUrl?: string;
  scope?: string;
  requiresAuthorization?: true;
};

export type McpOAuthStore = {
  /** Provenance for token-less rows that Doctor must interpret during legacy import. */
  credentialState?: "uninitialized" | "cleared";
  clientInformation?: OAuthClientInformationMixed;
  tokens?: OAuthTokens;
  tokenExpiresAt?: number;
  tokensAuthorizationServerUrl?: string;
  codeVerifier?: string;
  discoveryState?: OAuthDiscoveryState;
  lastAuthorizationUrl?: string;
  redirectUrl?: string;
  pendingAuthorizationChallenge?: McpOAuthAuthorizationChallenge;
};

export type McpOAuthMutation =
  | { kind: "clientInformation"; clientInformation: OAuthClientInformationMixed }
  | { kind: "tokens"; tokens: OAuthTokens; tokenExpiresAt: number | undefined }
  | {
      kind: "authorizationRedirect";
      authorizationUrl: string;
      redirectUrl?: string;
      codeVerifier?: string;
    }
  | { kind: "discoveryState"; discoveryState: OAuthDiscoveryState }
  | {
      kind: "invalidate";
      scope: "all" | "client" | "tokens" | "verifier" | "discovery";
      suppressStoredTokens: boolean;
    }
  | { kind: "bindTokensIssuer" }
  | {
      kind: "authorizationChallenge";
      resourceMetadataUrl?: string;
      scope?: string;
      requiresAuthorization?: true;
      rejectedAccessToken?: string;
    }
  | { kind: "completeAuthorization" };

export type McpOAuthWorkerOperations = WorkerOperations<typeof mcpOAuthOperations>;
