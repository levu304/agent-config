/**
 * context-mode — OpenCode V2 plugin bridge.
 *
 * Upstream `context-mode` (npm) still ships a V1-only OpenCode adapter
 * (`export default { id, server }` with `tool.execute.before`,
 * `experimental.chat.system.transform`, ...). V1 implementations do not run
 * in OpenCode V2, so this file loads the installed package's V1 factory and
 * re-registers each hook through the V2 API (`Plugin.define` + `setup`).
 *
 * Hook mapping (behavior preserved, only the transport changes):
 *   tool.execute.before                 -> ctx.tool.hook("execute.before")
 *   tool.execute.after                  -> ctx.tool.hook("execute.after")
 *   chat.message (user-prompt capture)  -> ctx.session.hook("prompt")
 *   experimental.chat.system.transform  -> ctx.session.hook("context")
 *   experimental.session.compacting     -> ctx.session.hook("compaction")
 *     (snapshot + auto-injection block are appended to the compaction
 *     prompt's system parts; the model still summarizes — V1 never
 *     skipped the summarizer, and setting result.summary would leave
 *     the resumed session with only the XML snapshot)
 *   event (message.updated usage)       -> ctx.event.subscribe()
 *
 * The ctx_* tools are NOT re-registered here (V2 tool definitions need JSON
 * Schema; the package builds Zod v4 schemas in-process). They are served by
 * the `context-mode` MCP server instead — see `mcp.servers["context-mode"]`
 * in opencode.jsonc, same as every other platform.
 *
 * Session/content SQLite data is untouched: the adapter resolves the same
 * `~/.config/opencode/context-mode/sessions/` paths as under V1.
 */

import { Plugin } from "@opencode/plugin";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { pathToFileURL } from "node:url";

const HOME = homedir();

// Absolute path to the V1 adapter inside the installed npm package.
// The bare specifier "context-mode" is tried last; absolute candidates first
// so a global (homebrew / /usr/local) install resolves deterministically.
function candidateEntries(): string[] {
  const fromEnv = process.env.CONTEXT_MODE_PLUGIN_ENTRY;
  return [
    ...(fromEnv ? [fromEnv] : []),
    `${HOME}/.config/opencode/node_modules/context-mode/build/adapters/opencode/plugin.js`,
    "/opt/homebrew/lib/node_modules/context-mode/build/adapters/opencode/plugin.js",
    "/usr/local/lib/node_modules/context-mode/build/adapters/opencode/plugin.js",
  ];
}

type V1Hook = (...args: any[]) => Promise<any>;
type V1Hooks = Record<string, V1Hook | undefined>;

function v1Log(tag: string, message: unknown, extra?: unknown): void {
  try {
    console.log(`[context-mode:${tag}]`, message ?? "", extra ?? "");
  } catch {
    // Logging must never break the turn.
  }
}

async function loadV1Hooks(directory: string): Promise<V1Hooks | null> {
  for (const entry of candidateEntries()) {
    if (!existsSync(entry)) continue;
    try {
      const mod = await import(pathToFileURL(entry).href);
      const server = mod?.default?.server ?? mod?.ContextModePlugin;
      if (typeof server !== "function") continue;
      const hooks = await server({
        client: {
          app: {
            log: async (o: any) =>
              v1Log("v1", o?.body?.message, o?.body?.extra),
          },
        },
        directory,
      });
      if (hooks && typeof hooks === "object") {
        if (entry !== candidateEntries()[0] || process.env.OPENCODE_DEBUG) {
          v1Log("init", `V1 hooks loaded from ${entry}`);
        }
        return hooks as V1Hooks;
      }
    } catch (err) {
      v1Log("init", `failed to init V1 hooks from ${entry}`, String(err));
    }
  }
  console.error(
    "[context-mode] V2 bridge inert: installed context-mode package not found. " +
      "Install it (`npm i -g context-mode`) or set CONTEXT_MODE_PLUGIN_ENTRY " +
      "to build/adapters/opencode/plugin.js. Searched: " +
      candidateEntries().join(", "),
  );
  return null;
}

function partText(p: unknown): string {
  if (typeof p === "string") return p;
  if (p && typeof p === "object") {
    const o = p as Record<string, unknown>;
    if (typeof o.text === "string") return o.text;
    if (typeof o.content === "string") return o.content;
  }
  return "";
}

function resultText(result: unknown, status: string, error: unknown): string {
  const r =
    result && typeof result === "object"
      ? (result as Record<string, unknown>)
      : {};
  if (typeof r.output === "string") return r.output;
  if (typeof r.content === "string") return r.content;
  if (Array.isArray(r.content)) {
    return r.content
      .filter(
        (c): c is { text: string } =>
          !!c && typeof c === "object" && (c as any).type === "text" &&
          typeof (c as any).text === "string",
      )
      .map((c) => c.text)
      .join("\n");
  }
  if (status === "error") {
    const msg = (error as any)?.message ?? (error as any)?.data?.message;
    if (typeof msg === "string" && msg) return msg;
  }
  try {
    return JSON.stringify(r);
  } catch {
    return "";
  }
}

export default Plugin.define({
  id: "context-mode",
  async setup(ctx) {
    const directory =
      (ctx as any)?.location?.directory &&
        typeof (ctx as any).location.directory === "string"
        ? (ctx as any).location.directory
        : process.cwd();

    const v1 = await loadV1Hooks(directory);
    if (!v1) return; // Inert; reason already logged.

    const get = (name: string): V1Hook | null => {
      const fn = v1[name];
      if (typeof fn !== "function") {
        v1Log("init", `upstream hook missing, skipping bridge: ${name}`);
        return null;
      }
      return fn;
    };

    const before = get("tool.execute.before");
    if (before) {
      await ctx.tool.hook("execute.before", (e: any) =>
        before(
          { tool: e.tool ?? "", sessionID: e.sessionID, callID: e.id ?? "" },
          // Same reference: V1 mutates output.args in place for
          // modify/context decisions; throwing blocks the call.
          { args: e.input },
        ));
    }

    const after = get("tool.execute.after");
    if (after) {
      await ctx.tool.hook("execute.after", (e: any) => {
        const text = resultText(
          e.status === "completed" ? e.result : {},
          e.status,
          (e as any).error,
        );
        const r =
          e.status === "completed" && e.result &&
            typeof e.result === "object"
            ? (e.result as Record<string, unknown>)
            : {};
        return after(
          {
            tool: e.tool ?? "",
            sessionID: e.sessionID,
            callID: e.id ?? "",
            args: e.input,
          },
          {
            title: typeof r.title === "string" ? r.title : "",
            output: text,
            metadata: r.metadata,
          },
        );
      });
    }

    const chatMessage = get("chat.message");
    if (chatMessage) {
      await ctx.session.hook("prompt", (e: any) => {
        const text = e?.prompt?.text;
        if (typeof text !== "string" || text.length === 0) return;
        return chatMessage(
          { sessionID: e.sessionID },
          { message: undefined, parts: [{ type: "text", text }] },
        );
      });
    }

    const systemTransform = get("experimental.chat.system.transform");
    if (systemTransform) {
      await ctx.session.hook("context", async (e: any) => {
        if (!Array.isArray(e.system)) return;
        const beforeTexts = e.system.map(partText);
        const out = { system: [...beforeTexts] };
        await systemTransform(
          { sessionID: e.sessionID, model: e.model },
          out,
        );
        // V1 only splices strings in (routing block, resume snapshot).
        // Map additions back to {type:"text"} parts at index 1, preserving
        // any non-text parts already present.
        const remaining = [...beforeTexts];
        const added: string[] = [];
        for (const s of out.system) {
          const i = remaining.indexOf(s);
          if (i === -1) added.push(s);
          else remaining.splice(i, 1);
        }
        if (added.length > 0) {
          e.system.splice(
            1,
            0,
            ...added.map((text) => ({ type: "text", text })),
          );
        }
      });
    }

    const compacting = get("experimental.session.compacting");
    if (compacting) {
      await ctx.session.hook("compaction", async (e: any) => {
        // V1 semantics: output.context is EXTRA context for the model
        // summarizer, not a replacement summary. So inject into the
        // compaction prompt and let the model run — never set e.result.
        // (Setting e.result skips the model and leaves the compacted
        // session with only the XML snapshot, breaking resume.)
        const context: string[] = [];
        try {
          await compacting({ sessionID: e.sessionID }, { context });
        } catch {
          return;
        }
        if (context.length > 0 && Array.isArray(e.system)) {
          e.system.push(
            ...context.map((text) => ({ type: "text", text })),
          );
        }
      });
    }

    const busEvent = get("event");
    if (busEvent) {
      const controller = new AbortController();
      void (async () => {
        try {
          for await (
            const ev of ctx.event.subscribe({ signal: controller.signal })
          ) {
            try {
              const t = (ev as any)?.type;
              if (t !== "message.updated") continue;
              const data = (ev as any)?.data as
                | { sessionID?: unknown; info?: unknown }
                | undefined;
              if (!data || typeof data.info !== "object" || !data.info) {
                continue;
              }
              const sid = typeof data.sessionID === "string"
                ? data.sessionID
                : undefined;
              await busEvent({
                event: {
                  type: t,
                  properties: {
                    info: {
                      ...(data.info as Record<string, unknown>),
                      ...(sid ? { sessionID: sid } : {}),
                    },
                  },
                },
              });
            } catch {
              // Per-event guard: usage capture must never break the session.
            }
          }
        } catch {
          // Stream ended with plugin unload.
        }
      })();
      return () => controller.abort();
    }

    return undefined;
  },
});
