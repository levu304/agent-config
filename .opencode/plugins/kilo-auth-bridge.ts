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
 *
 * ponytail: no model snapshot — user declares kilo models in config
 * (README: provider.kilo with npm `@openrouter/ai-sdk-provider`). Adding a
 * snapshot here would duplicate 342 models for zero gain; add only if auto-
 * registration is explicitly requested.
 */
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { pathToFileURL } from "node:url";

const PROVIDER_ID = "kilo";
const PROVIDER_NAME = "Kilo Gateway";
const API_KEY_ENV = "KILO_API_KEY";
const PROVIDER_NPM = "@openrouter/ai-sdk-provider";
const AISDK_PREFIX = "aisdk:";
const FALLBACK_BASE_URL = "https://api.kilo.ai/api/openrouter";

function candidateBases(): string[] {
  const fromEnv = process.env.KILO_PLUGIN_ENTRY;
  const home = homedir();
  return [
    ...(fromEnv ? [fromEnv] : []),
    `${home}/.cache/opencode/npm/opencode-kilo-auth@latest/1790133244922/node_modules/opencode-kilo-auth`,
  ];
}

async function loadV1(): Promise<any | null> {
  for (const base of candidateBases()) {
    const entry = `${base}/dist/index.js`;
    if (!existsSync(entry)) continue;
    try {
      const mod = await import(pathToFileURL(entry).href);
      const fn = mod?.default;
      if (typeof fn === "function") return { fn, base };
      console.log(`[kilo-auth-bridge] unexpected default export in ${entry}`);
    } catch (err) {
      console.log(`[kilo-auth-bridge] failed to import ${entry}`, String(err));
    }
  }
  return null;
}

async function loadRuntime(base: string): Promise<any | null> {
  try {
    const mod = await import(pathToFileURL(`${base}/dist/provider.js`).href);
    if (typeof mod?.createKilo === "function") return mod;
  } catch {
    // Degraded registration beats a plugin that will not load (ADR-0009).
  }
  return null;
}

// V1 half: preserves `opencode auth login` device + api-key flows on V1 hosts.
const server = async (input: any) => {
  const v1 = await loadV1();
  if (!v1) return {};
  return await v1.fn(input);
};

function registerProvider(editor: any, specifier: string, baseURL: string) {
  editor.update(PROVIDER_ID, (provider: any) => {
    if (provider.name === provider.id) provider.name = PROVIDER_NAME;
    if (provider.package === "") provider.package = specifier;
    if (provider.integrationID === undefined) provider.integrationID = PROVIDER_ID;
    if (provider.settings?.["baseURL"] === undefined) {
      provider.settings ??= {};
      provider.settings["baseURL"] = baseURL;
    }
  });
}

function registerIntegration(integrations: any) {
  integrations.update(PROVIDER_ID, (integration: any) => {
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
const setup = async (ctx: any) => {
  const v1 = await loadV1();
  const base = v1?.base as string | undefined;
  let baseURL = FALLBACK_BASE_URL;
  let createKilo: any = null;
  if (base) {
    try {
      const c = await import(pathToFileURL(`${base}/dist/constants.js`).href);
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
  await ctx.provider.transform((editor: any) => registerProvider(editor, specifier, baseURL));
  await ctx.integration.transform(registerIntegration);
  if (createKilo) {
    const factory = createKilo;
    await ctx.aisdk.hook(
      "sdk",
      (event: any) => {
        if (event?.model?.providerID !== PROVIDER_ID) return;
        const options = { ...(event.options ?? {}) };
        options.headers = {
          "HTTP-Referer": "https://kilo.ai",
          "X-Title": "Kilo Gateway",
          ...(options.headers ?? {}),
        };
        if (options.baseURL === undefined) options.baseURL = baseURL;
        event.sdk = factory(options);
      },
      { providerID: PROVIDER_ID },
    );
  }
};

export default { id: "kilo-auth", server, setup };
