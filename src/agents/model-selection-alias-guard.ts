/** Alias precedence guard for explicit provider-qualified model references. */
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { ModelRef } from "./model-ref-shared.js";
import { normalizeProviderId } from "./model-ref-shared.js";
import { findNormalizedProviderValue } from "./model-selection-normalize.js";

function hasSlashFormModelRef(raw: string): boolean {
  const trimmed = raw.trim();
  const slash = trimmed.indexOf("/");
  return slash > 0 && slash < trimmed.length - 1;
}

/**
 * A leading segment naming the default provider or a configured provider row is
 * an explicit provider choice, so a slash-form alias must not capture it when
 * the alias target belongs to a different provider.
 */
export function aliasRewritesProvider(
  raw: string,
  ref: ModelRef,
  params: { cfg?: OpenClawConfig; defaultProvider: string },
): boolean {
  const slash = raw.indexOf("/");
  if (slash <= 0) {
    return false;
  }
  const providerId = normalizeProviderId(raw.slice(0, slash));
  if (!providerId) {
    return false;
  }
  const explicitProvider =
    providerId === normalizeProviderId(params.defaultProvider) ||
    Boolean(findNormalizedProviderValue(params.cfg?.models?.providers, providerId));
  return explicitProvider && normalizeProviderId(ref.provider) !== providerId;
}

/**
 * Decide whether a slash-form primary input should be parsed directly before an
 * alias candidate is allowed to win: the candidate key is not itself slash-form,
 * or the alias would rewrite an authoritative explicit provider.
 */
export function parsePrimaryBeforeAlias(
  primaryRaw: string,
  aliasCandidate: { keyRaw: string; ref: ModelRef } | null | undefined,
  params: { cfg?: OpenClawConfig; defaultProvider: string },
): boolean {
  if (!aliasCandidate || !hasSlashFormModelRef(primaryRaw)) {
    return false;
  }
  return (
    !hasSlashFormModelRef(aliasCandidate.keyRaw) ||
    aliasRewritesProvider(primaryRaw, aliasCandidate.ref, params)
  );
}
