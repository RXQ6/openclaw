// Regression coverage: explicit provider-qualified model references must not be
// hijacked by configured alias text that itself contains `provider/model`.
import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/types.js";
import {
  buildModelAliasIndex,
  resolveConfiguredModelRef,
  resolveModelRefFromString,
} from "./model-selection-resolve.js";

function createAliasConfig(params: { primary?: string; modelEntries: Record<string, unknown> }) {
  return {
    ...(params.primary !== undefined
      ? {
          agents: { defaults: { model: { primary: params.primary }, models: params.modelEntries } },
        }
      : { agents: { defaults: { models: params.modelEntries } } }),
  } as unknown as OpenClawConfig;
}

describe("explicit provider refs versus slash-form alias text", () => {
  it("keeps an explicit provider ref authoritative when an alias text contains provider/model", () => {
    const index = buildModelAliasIndex({
      cfg: createAliasConfig({
        modelEntries: { "openrouter/openai/gpt-4o-mini": { alias: "openai/gpt-4o-mini" } },
      }),
      defaultProvider: "openai",
    });

    expect(
      resolveModelRefFromString({
        raw: "openai/gpt-4o-mini",
        defaultProvider: "openai",
        aliasIndex: index,
      }),
    ).toEqual({ ref: { provider: "openai", model: "gpt-4o-mini" } });
  });

  it("keeps provider-consistent slash-form aliases ahead of provider/model parsing", () => {
    const index = buildModelAliasIndex({
      cfg: createAliasConfig({
        modelEntries: { "openai/claude-sonnet-4-6": { alias: "openai/sonnet" } },
      }),
      defaultProvider: "openai",
    });

    expect(
      resolveModelRefFromString({
        raw: "openai/sonnet",
        defaultProvider: "openai",
        aliasIndex: index,
      }),
    ).toEqual({ ref: { provider: "openai", model: "claude-sonnet-4-6" }, alias: "openai/sonnet" });
  });

  it("resolves slash-form alias text when its leading segment is not the default provider", () => {
    // Established OpenRouter-style nested-id alias lookup keeps working when
    // the leading segment does not name an authoritative provider.
    const index = buildModelAliasIndex({
      cfg: createAliasConfig({
        modelEntries: { "openai/xiaomi/mimo-v2-pro-mit": { alias: "xiaomi/mimo-v2-pro-mit" } },
      }),
      defaultProvider: "openai",
    });

    expect(
      resolveModelRefFromString({
        raw: "xiaomi/mimo-v2-pro-mit",
        defaultProvider: "openai",
        aliasIndex: index,
      }),
    ).toEqual({
      ref: { provider: "openai", model: "xiaomi/mimo-v2-pro-mit" },
      alias: "xiaomi/mimo-v2-pro-mit",
    });
  });

  it("keeps an explicit primary provider authoritative when an alias text contains provider/model", () => {
    const cfg = createAliasConfig({
      primary: "openai/gpt-4o-mini",
      modelEntries: { "openrouter/openai/gpt-4o-mini": { alias: "openai/gpt-4o-mini" } },
    });

    expect(
      resolveConfiguredModelRef({
        cfg,
        defaultProvider: "openai",
        defaultModel: "gpt-5.4",
      }),
    ).toEqual({ provider: "openai", model: "gpt-4o-mini" });
  });
});
