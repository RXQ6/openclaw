import { gatewayCredentialScope } from "@openclaw/gateway-client/browser";
import type { GatewayBrowserClient, GatewayBrowserClientOptions } from "../api/gateway.ts";
import { loadCurrentDeviceAuthToken } from "../lib/nodes/index.ts";
import { readBootRecord } from "./boot-record.ts";
import type { ApplicationGatewayConnection } from "./gateway.ts";

/** Prepare local storage identity separately from credentials sent by connect. */
export function prepareGatewayClientCredentials(
  connection: ApplicationGatewayConnection,
  credentialsChanged: boolean,
  previousClient: Pick<GatewayBrowserClient, "offlineRecoveryScope"> | null,
): Pick<
  GatewayBrowserClientOptions,
  "offlineRecoveryScope" | "url" | "token" | "bootstrapToken" | "bootstrapProfile" | "password"
> {
  const boot =
    !credentialsChanged && !connection.bootstrapToken && !connection.password
      ? readBootRecord(gatewayCredentialScope(connection.gatewayUrl), (method) =>
          method === "token"
            ? connection.token
            : connection.token.trim()
              ? null
              : method === "device-token"
                ? loadCurrentDeviceAuthToken(connection.gatewayUrl)
                : "",
        )
      : null;
  return {
    offlineRecoveryScope: !credentialsChanged
      ? (previousClient?.offlineRecoveryScope ?? boot?.recoveryScope)
      : undefined,
    url: connection.gatewayUrl,
    token: connection.token.trim() ? connection.token : undefined,
    bootstrapToken: connection.bootstrapToken.trim() ? connection.bootstrapToken : undefined,
    bootstrapProfile: connection.bootstrapProfile,
    password: connection.password.trim() ? connection.password : undefined,
  };
}
