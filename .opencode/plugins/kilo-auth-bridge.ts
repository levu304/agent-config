/**
 * kilo-auth-bridge — V2 shim for `opencode-kilo-auth` (V1-only upstream).
 *
 * Upstream `opencode-kilo-auth@1.1.4` exports a V1 function
 * (`export default async (input) => ({ auth: ... })`) built on
 * `@opencode-ai/plugin`. OpenCode V2 requires an object
 * `{ id, setup|effect }`, so the bare `"opencode-kilo-auth"` spec fails with
 * `SchemaError(Expected object at ["default"])`.
 *
 * This file keeps the V1 `server` function for backward compat (dual export,
 * same as `opencode-cmd-provider`: unknown keys are stripped by the V2 loader,
 * V1 loader only inspects `id`/`server`) and adds a native V2 `setup` that
 * registers the same capability through transforms:
 *   v1 `auth.provider=kilo` + loader -> `ctx.provider.transform` (package,
 *     baseURL, integrationID) + `ctx.aisdk.hook("sdk")` (createKilo runtime)
 *   v1 `auth.methods` (device oauth + api key) -> `ctx.integration.transform`
 *     (env `KILO_API_KEY` + key method; V2 method registry has no oauth arm —
 *     device flow stays available via V1 `server` + `opencode auth login`)
 *   v1 `fetchKiloModels` (dist/models.js) -> free-tier (`:free` /
 *     zero-cost) models auto-registered via `editor.models.update`
 *     inside `ctx.provider.transform`; user-declared models win.
 *
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { pathToFileURL } from "node:url";

const PROVIDER_ID = "kilo";
const PROVIDER_NAME = "Kilo Gateway";
const API_KEY_ENV = "KILO_API_KEY";
const PROVIDER_NPM = "@openrouter/ai-sdk-provider";
const AISDK_PREFIX = "aisdk:";
const FALLBACK_BASE_URL = "https://api.kilo.ai/api/openrouter";

// ---------------------------------------------------------------------------
// Local type mirrors. Both halves load through computed dynamic imports, so
// no static specifier exists to `import type` from: the V1 package resolves
// only inside version-timestamped npm cache directories
// (`~/.cache/opencode/npm/opencode-kilo-auth@latest/<ts>/...`), and this
// file lives outside any package graph. Each mirror is copied from the cited
// source so the bridge stays self-contained and `any`-free.
// ---------------------------------------------------------------------------

/** V1 default export — `dist/index.d.ts` (`KiloGatewayPlugin`, a `Plugin` fn from `@opencode-ai/plugin`). Input and result are forwarded untouched, hence `unknown`. */
type V1PluginFn = (
  input: unknown,
  options?: Record<string, unknown>,
) => Promise<unknown>;
/** `dist/index.js` module surface — only the default export is consumed. */
type V1Module = { default?: V1PluginFn };
/** Resolved V1 entry: the default export plus the cache base it was loaded from. */
type V1Entry = { fn: V1PluginFn; base: string };

/** `KiloProviderOptions` — `opencode-kilo-auth@1.1.4` `dist/types.d.ts` lines 35–46. */
type V1KiloProviderOptions = {
  kiloToken?: string;
  kiloOrganizationId?: string;
  kiloModel?: string;
  openRouterSpecificProvider?: string;
  baseURL?: string;
  headers?: Record<string, string>;
  apiKey?: string;
  name?: string;
  fetch?: typeof fetch;
  timeout?: number | false;
};
/** `dist/provider.d.ts` module surface — `createKilo` returns an `OpenRouterProvider` (`@openrouter/ai-sdk-provider`), which the bridge only forwards to `event.sdk`, hence `unknown`. */
type V1ProviderModule = {
  createKilo(options?: V1KiloProviderOptions): unknown;
};
/** The `createKilo` handle `setup` keeps. */
type V1CreateKilo = (options?: V1KiloProviderOptions) => unknown;

/** `dist/constants.d.ts` — only `KILO_OPENROUTER_BASE` is consumed. */
type V1ConstantsModule = { readonly KILO_OPENROUTER_BASE: string };

/**
 * V1 model record — runtime shape produced by `dist/models.js`
 * `transformToModelDevFormat` (lines 88–119). That shape is not exported
 * from the package `.d.ts` (which declares `Record<string, any>`), so it is
 * mirrored here; only the fields this bridge reads are listed.
 */
interface V1ModelInfo {
  id: string;
  name: string;
  family?: string;
  tool_call: boolean;
  limit: { context: number; output: number };
  cost?: { input: number; output: number };
  modalities?: { input: string[]; output: string[] };
}
/** `dist/models.d.ts` — `fetchKiloModels` with the `any` value type narrowed to the runtime shape above. */
type V1ModelsModule = {
  fetchKiloModels(options?: {
    kiloToken?: string;
    kiloOrganizationId?: string;
    baseURL?: string;
  }): Promise<Record<string, V1ModelInfo>>;
};

// V2 host surface — mirrors of OpenCode V2's `@opencode/plugin` host API as
// shipped in the sibling plugin `opencode-cmd-provider`
// (`dist/src/plugin/v2-types.d.ts`). Only the domains `setup` touches are
// mirrored (provider, integration, aisdk); the host's real objects carry more
// members and remain assignable to these subsets.

/** `v2-types.d.ts` lines 2–12. */
interface V2ProviderInfo {
  id: string;
  canonical?: string;
  integrationID?: string;
  name: string;
  activation: "auto" | "enabled" | "disabled";
  package: string;
  settings?: Record<string, unknown>;
  headers?: Record<string, string>;
  body?: Record<string, unknown>;
}
/** `v2-types.d.ts` lines 14–25. */
interface V2ModelCost {
  tier?: { type: "context"; size: number };
  input: number;
  output: number;
  cache: { read: number; write: number };
}
/** `v2-types.d.ts` lines 26–31. */
interface V2ModelVariant {
  id: string;
  settings?: Record<string, unknown>;
  headers?: Record<string, string>;
  body?: Record<string, unknown>;
}
/** `v2-types.d.ts` lines 33–65. */
interface V2ModelInfo {
  id: string;
  modelID: string;
  providerID: string;
  canonical?: string;
  family?: string;
  name: string;
  compatibility?: { reasoningField?: string; requireReasoning?: boolean };
  package?: string;
  settings?: Record<string, unknown>;
  headers?: Record<string, string>;
  body?: Record<string, unknown>;
  capabilities: { tools: boolean; input: string[]; output: string[] };
  variants: V2ModelVariant[];
  time: { released: number };
  cost: V2ModelCost[];
  status: "alpha" | "beta" | "deprecated" | "active";
  enabled: boolean;
  limit: { context: number; input?: number; output: number };
}
/** `v2-types.d.ts` lines 66–69. */
interface V2ProviderRecord {
  readonly provider: V2ProviderInfo;
  readonly models: ReadonlyMap<string, V2ModelInfo>;
}
/** `v2-types.d.ts` lines 77–91 — the members this bridge calls. */
interface V2ProviderEditor {
  get(providerID: string): V2ProviderRecord | undefined;
  update(providerID: string, update: (provider: V2ProviderInfo) => void): void;
  readonly models: {
    update(
      providerID: string,
      modelID: string,
      update: (model: V2ModelInfo) => void,
    ): void;
  };
}
/** `v2-types.d.ts` lines 114–117. */
interface V2IntegrationRef {
  id: string;
  name: string;
}
/** `v2-types.d.ts` lines 118–120. */
interface V2IntegrationEnvMethod {
  type: "env";
  names: readonly string[];
}
/** `v2-types.d.ts` lines 122–124. */
interface V2IntegrationKeyMethod {
  type: "key";
  label?: string;
}
/** `v2-types.d.ts` lines 126–132. */
type V2IntegrationMethodRegistration =
  | { integrationID: string; method: V2IntegrationEnvMethod }
  | { integrationID: string; method: V2IntegrationKeyMethod };
/** `v2-types.d.ts` lines 134–144 — the members this bridge calls. */
interface V2IntegrationEditor {
  update(id: string, update: (integration: V2IntegrationRef) => void): void;
  method: {
    update(input: V2IntegrationMethodRegistration): void;
  };
}
/** `v2-types.d.ts` lines 228–233. */
interface V2SDKEvent {
  readonly model: V2ModelInfo;
  readonly package: string;
  readonly options: Record<string, unknown>;
  sdk?: unknown;
}
/** `v2-types.d.ts` lines 239–277 — the `setup` context slice this bridge consumes. */
interface V2SetupContext {
  readonly provider: {
    transform(callback: (editor: V2ProviderEditor) => void): Promise<unknown>;
  };
  readonly integration: {
    transform(callback: (editor: V2IntegrationEditor) => void): Promise<unknown>;
  };
  readonly aisdk: {
    hook(
      name: "sdk",
      callback: (event: V2SDKEvent) => void,
      options?: { providerID?: string },
    ): Promise<unknown>;
  };
}

function candidateBases(): string[] {
  const fromEnv = process.env.KILO_PLUGIN_ENTRY;
  if (fromEnv) {
    return [fromEnv];
  }
  const home = homedir();
  const bases: string[] = [];
  const latestDir = `${home}/.cache/opencode/npm/opencode-kilo-auth@latest`;
  if (existsSync(latestDir)) {
    try {
      const entries = readdirSync(latestDir);
      const numericEntries = entries.filter((e) => /^\d+$/.test(e));
      if (numericEntries.length > 0) {
        numericEntries.sort((a, b) => Number(b) - Number(a));
        for (const ts of numericEntries.slice(0, 3)) {
          bases.push(`${latestDir}/${ts}/node_modules/opencode-kilo-auth`);
        }
      }
    } catch {
      // ignore
    }
  }
  if (bases.length === 0) {
    bases.push(`${latestDir}/1790133244922/node_modules/opencode-kilo-auth`);
  }
  return bases;
}

async function loadV1(): Promise<V1Entry | null> {
  for (const base of candidateBases()) {
    const entry = `${base}/dist/index.js`;
    if (!existsSync(entry)) continue;
    try {
      const mod = (await import(pathToFileURL(entry).href)) as V1Module;
      const fn = mod?.default;
      if (typeof fn === "function") return { fn, base };
      console.log(`[kilo-auth-bridge] unexpected default export in ${entry}`);
    } catch (err) {
      console.log(`[kilo-auth-bridge] failed to import ${entry}`, String(err));
    }
  }
  return null;
}

async function loadRuntime(base: string): Promise<V1ProviderModule | null> {
  try {
    const mod = (await import(pathToFileURL(`${base}/dist/provider.js`).href)) as V1ProviderModule;
    if (typeof mod?.createKilo === "function") return mod;
  } catch {
    // Degraded registration beats a plugin that will not load (ADR-0009).
  }
  return null;
}

// V1 half: preserves `opencode auth login` device + api-key flows on V1 hosts.
const server = async (input: unknown): Promise<unknown> => {
  const v1 = await loadV1();
  if (!v1) return {};
  return await v1.fn(input);
};

function registerProvider(editor: V2ProviderEditor, specifier: string, baseURL: string) {
  editor.update(PROVIDER_ID, (provider: V2ProviderInfo) => {
    if (provider.name === provider.id) provider.name = PROVIDER_NAME;
    if (provider.package === "") provider.package = specifier;
    if (provider.integrationID === undefined) provider.integrationID = PROVIDER_ID;
    if (provider.settings?.["baseURL"] === undefined) {
      provider.settings ??= {};
      provider.settings["baseURL"] = baseURL;
    }
  });
}

// Free-tier catalog: V1 `dist/models.js` export (zod-validated, 10s timeout).
async function loadFreeModels(base: string, baseURL: string): Promise<Map<string, V1ModelInfo>> {
  try {
    const mod = (await import(pathToFileURL(`${base}/dist/models.js`).href)) as V1ModelsModule;
    if (typeof mod?.fetchKiloModels !== "function") return new Map();
    const models: Record<string, V1ModelInfo> = await mod.fetchKiloModels({ baseURL });
    return new Map(Object.entries(models ?? {}));
  } catch (err) {
    console.log("[kilo-auth-bridge] failed to fetch kilo free models", String(err));
    return new Map();
  }
}

function isFreeModel(v1Model: V1ModelInfo): boolean {
  if (typeof v1Model?.id === "string" && v1Model.id.endsWith(":free")) return true;
  return !v1Model?.cost || (v1Model.cost.input === 0 && v1Model.cost.output === 0);
}

function freeModelToV2(v1Model: V1ModelInfo): Partial<V2ModelInfo> {
  const draft: Partial<V2ModelInfo> = {
    name: v1Model.name,
    limit: { context: v1Model.limit.context, output: v1Model.limit.output },
    capabilities: {
      tools: v1Model.tool_call ?? false,
      input: v1Model.modalities?.input ?? [],
      output: v1Model.modalities?.output ?? ["text"],
    },
    cost: [{ input: 0, output: 0, cache: { read: 0, write: 0 } }],
    status: "active",
    enabled: true,
  };
  if (v1Model.family !== undefined) draft.family = v1Model.family;
  return draft;
}

function registerIntegration(integrations: V2IntegrationEditor) {
  integrations.update(PROVIDER_ID, (integration: V2IntegrationRef) => {
    if (integration.name === integration.id) integration.name = PROVIDER_NAME;
  });
  integrations.method.update({
    integrationID: PROVIDER_ID,
    method: { type: "env", names: [API_KEY_ENV] },
  });
  integrations.method.update({
    integrationID: PROVIDER_ID,
    method: { type: "key", label: `${PROVIDER_NAME} API key` },
  });
}

// V2 half: same three capabilities through the transform API.
const setup = async (ctx: V2SetupContext): Promise<void> => {
  const v1 = await loadV1();
  const base = v1?.base as string | undefined;
  let baseURL = FALLBACK_BASE_URL;
  let createKilo: V1CreateKilo | null = null;
  if (base) {
    try {
      const c = (await import(pathToFileURL(`${base}/dist/constants.js`).href)) as V1ConstantsModule;
      if (typeof c?.KILO_OPENROUTER_BASE === "string") baseURL = c.KILO_OPENROUTER_BASE;
    } catch {
      // Keep fallback; reason already logged by loadV1 on hard failures.
    }
    createKilo = (await loadRuntime(base))?.createKilo ?? null;
  } else {
    console.log(
      "[kilo-auth-bridge] V1 package not found, registering provider shell only. " +
        `Set KILO_PLUGIN_ENTRY or install opencode-kilo-auth. Searched: ${candidateBases().join(", ")}`,
    );
  }

  const specifier = `${AISDK_PREFIX}${PROVIDER_NPM}`;
  // Free models: fetched before the transforms so the picker is
  // populated on first load (bounded by upstream's 10s timeout).
  let freeModels: V1ModelInfo[] = [];
  if (base) {
    const fetched = await loadFreeModels(base, baseURL);
    freeModels = [...fetched.values()].filter(isFreeModel);
    if (freeModels.length === 0 && fetched.size > 0) {
      console.log("[kilo-auth-bridge] kilo catalog has no free-tier models");
    }
  }
  await ctx.provider.transform((editor: V2ProviderEditor) => {
    registerProvider(editor, specifier, baseURL);
    // Additive registration: user-declared models win, never overwritten.
    for (const model of freeModels) {
      if (editor.get(PROVIDER_ID)?.models.get(model.id)) continue;
      editor.models.update(PROVIDER_ID, model.id, (entry: V2ModelInfo) =>
        Object.assign(entry, freeModelToV2(model)),
      );
    }
  });
  await ctx.integration.transform(registerIntegration);
  if (createKilo) {
    const factory = createKilo;
    await ctx.aisdk.hook(
      "sdk",
      (event: V2SDKEvent) => {
        if (event?.model?.providerID !== PROVIDER_ID) return;
        // The host hands SDK options over as an unknown-shaped bag
        // (`V2SDKEvent.options`); `createKilo` declares the V1
        // `KiloProviderOptions` surface it reads, so the bag is
        // asserted (narrowed, not widened) before forwarding.
        const options = { ...(event.options ?? {}) } as V1KiloProviderOptions;
        options.headers = {
          "HTTP-Referer": "https://kilo.ai",
          "X-Title": "Kilo Gateway",
          ...(options.headers ?? {}),
        };
        if (options.baseURL === undefined) options.baseURL = baseURL;
        // V2 host doesn't inject credentials into event.options; pull the
        // stored OAuth access token the same way V1's loader does.
        if (options.apiKey === undefined && options.kiloToken === undefined) {
          try {
            const auth = JSON.parse(readFileSync(`${homedir()}/.local/share/opencode/auth.json`, "utf8"));
            if (typeof auth?.kilo?.access === "string") options.apiKey = auth.kilo.access;
          } catch { /* stay anonymous */ }
        }
        event.sdk = factory(options);
      },
      { providerID: PROVIDER_ID },
    );
  }
};

export default { id: "kilo-auth", server, setup };
