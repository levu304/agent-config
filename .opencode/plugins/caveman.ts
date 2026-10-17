import { Plugin } from "@opencode/plugin";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// ---------------------------------------------------------------------------
// V2 API signatures confirmed against the installed @opencode/plugin 2.0.11
// (task 1.1 — feedback send for void execute + command primitive):
//
//   dist/promise/command.d.ts:
//     export interface CommandInvocation {
//         readonly sessionID: Session.ID;
//         readonly prompt: PromptInput.Prompt;
//         readonly delivery: SessionInbox.Delivery;
//     }
//     export interface CommandDefinition {
//         readonly name: string;
//         readonly description?: string;
//         readonly execute: (input: CommandInvocation) => Promise<void>;
//     }
//     export interface CommandEditor { add(definition: CommandDefinition): void; }
//
//   `execute` returns Promise<void>, so feedback goes through the session client
//   from inside it. SessionDomain (dist/promise/session.d.ts:143) picks
//   `synthetic` from SessionApi, and the V2 docs' Commands section shows
//   `ctx.session.synthetic({ sessionID, text })` for transient messages — used
//   here as the confirmation/error send. There is no native V2 picker primitive;
//   `/caveman config` falls back to a message listing the current defaults
//   (fallback documented in design.md Risks).
//
//   dist/promise/session.d.ts (task 1.2 — hook event shapes):
//     export interface SessionContext extends SessionRequest {
//         readonly agent: Agent.ID;
//         tools: Record<string, { description: string; input: JsonSchema.JsonSchema; }>;
//     }
//     export interface SessionRequest {
//         readonly sessionID: Session.ID;
//         readonly model: Model.Ref;
//         system: Array<SystemPart>;
//         messages: Array<Message>;
//         options: SessionRequestOptions;
//     }
//     export interface SessionCompaction extends SessionContext {
//         /** Set to use this compaction and skip the model request. */
//         result?: SessionCompactionResult;
//     }
//   `e.sessionID` (readonly), `e.system` (mutable Array<SystemPart>, entries are
//   `{ type: "text", text }` objects), `e.result` optional and only assigned to
//   bypass the summarizer — the compaction hook pushes to `e.system` only and
//   never assigns `e.result`.
// ---------------------------------------------------------------------------

// --- Pure level model (task 2.1) --------------------------------------------

export const LEVELS = [
  "off",
  "lite",
  "full",
  "ultra",
  "wenyan-lite",
  "wenyan",
  "wenyan-ultra",
  "micro",
] as const;
export type Level = (typeof LEVELS)[number];

/** `stop`/`quit` resolve to `off` (caveman-levels spec). */
export const ALIASES: Record<string, Level> = { stop: "off", quit: "off" };

/** Resolve one raw argument. `undefined` = bare invocation (toggle). `null` = unknown. */
export function resolveInput(arg?: string): Level | "toggle" | null {
  if (arg === undefined) return "toggle";
  const normalized = arg.trim().toLowerCase();
  if (normalized === "") return "toggle";
  if (Object.hasOwn(ALIASES, normalized)) return ALIASES[normalized];
  return (LEVELS as readonly string[]).includes(normalized) ? (normalized as Level) : null;
}

/** Toggle off <-> last non-off (default `full`). */
export function toggleLevel(current: Level, lastNonOff: Level | null): Level {
  return current === "off" ? (lastNonOff ?? "full") : "off";
}

/**
 * Validate an intended level against the model. Returns `{ level }` on success,
 * `{ error }` (listing every valid level plus `stop`, `quit`, `config`) on
 * unknown input — caller leaves state unchanged.
 */
export function validateLevel(raw: string): { level: Level; error?: undefined } | { level?: undefined; error: string } {
  const resolved = resolveInput(raw);
  if (resolved && resolved !== "toggle") return { level: resolved };
  const valid = [...LEVELS, "stop", "quit", "config"].join(", ");
  return { error: `Unknown caveman level "${raw}". Valid: ${valid}` };
}

// --- Pure prompt text (task 2.2) --------------------------------------------
// Strings lifted from the live caveman skill (SKILL.md, 2026-10-14).

const BASE = `Respond terse like smart caveman. All technical substance stay. Only fluff die.

Rules:
- Drop: articles (a/an/the), filler (just/really/basically/actually/simply), pleasantries (sure/certainly/of course/happy to), hedging. Fragments OK. Short synonyms (big not extensive). No tool-call narration, no decorative tables/emoji, no dumping long raw error logs unless asked quote shortest decisive line. Standard well-known tech acronyms OK (DB/API/HTTP); never invent new abbreviations (cfg/impl/req/res/fn). No causal arrows. Technical terms exact. Code blocks unchanged. Errors quoted exact.
- Never drop not/never/no/only/except flip meaning worse than any token saved. Numbers, units exact.
- Never ADD word to sound caveman. Compression only style never grow output. No inserted pronoun or copula to fake broken grammar. Keep correct verb form when correct form cost same.
- Clarity register: mix ASD-STE100 Simplified Technical English, always. One idea per sentence, target 20 words max. Active voice, present tense where true. One word one meaning. Instruction = imperative. Noun cluster 3 words max. Pronoun only with one clear referent.
- Tool calls: fire direct. No preamble, plan, or progress note before or between calls. Text before call only to clarify, warn security/irreversible, or resolve ambiguity.
- Preserve user's dominant language exactly; compress the style, not the language. ALWAYS keep technical terms, code, API names, CLI commands, commit-type keywords, and exact error strings verbatim unless user explicitly asks for translation.
- Pattern: [thing] [action] [reason]. [next step].
- Answer directly in this style. Skip "caveman mode on" prefixes or recaps. User asks what mode is: say so plainly.`;

const INTENSITY: Record<Exclude<Level, "off" | "micro">, string> = {
  lite: `Intensity lite: No filler/hedging. Keep articles + full sentences. Professional but tight.`,
  full: `Intensity full: Drop articles, fragments OK, short synonyms. Classic caveman. No tool-call narration, no decorative tables/emoji, no long raw error-log dumps unless asked. Standard acronyms OK; no invented abbreviations.`,
  ultra: `Intensity ultra: Strip conjunctions when cause-then-effect stay unambiguous. One word when one word enough. State each fact once. NO prose abbreviations (cfg/impl/req/res/fn/auth), NO arrows (X -> Y). Code symbols, function names, API names, error strings: never touch.`,
  "wenyan-lite": `Intensity wenyan-lite: Semi-classical. Drop filler/hedging but keep grammar structure, classical register.`,
  wenyan: `Intensity wenyan: Maximum classical terseness. Fully wenyan (classical Chinese). 80-90% character reduction chars, not tokens. Classical sentence patterns, verbs precede objects, subjects often omitted, classical particles. Classical chars = wenyan modes only; never swap a word to a classical char at non-wenyan levels.`,
  "wenyan-ultra": `Intensity wenyan-ultra: Extreme abbreviation while keeping classical Chinese feel. Maximum compression, ultra terse.`,
};

const SAFETY = `Auto-Clarity - drop caveman style for: security warnings, irreversible action confirmations, multi-step sequences where fragment order risks misread, compression that creates technical ambiguity, and when the user asks to clarify or repeats a question. Resume caveman after the clear part done.`;

const MICRO_PROMPT = `Micro: Ultra-compressed communication mode. Levels: lite, full, ultra and the wenyan variants. Cut output tokens while keeping technical accuracy. Terse responses only; all technical substance stays.`;

/**
 * Build the injection for a level. Non-off non-micro: BASE + INTENSITY + SAFETY.
 * `micro`: MICRO_PROMPT + SAFETY only. `off`: null (nothing injected).
 * Wenyan levels keep technical terms in English (per BASE rules).
 */
export function buildPrompt(level: Level): string | null {
  if (level === "off") return null;
  if (level === "micro") return `${MICRO_PROMPT}\n\n${SAFETY}`;
  return `${BASE}\n\n${INTENSITY[level]}\n\n${SAFETY}`;
}

// --- State sidecars (task 3) -----------------------------------------------
// Additive: existing caveman.json { enabled, defaultMode, features } preserved.

interface CavemanDefaults {
  enabled?: boolean;
  defaultMode?: string;
  features?: Record<string, boolean>;
  defaultLevel?: Level;
}

export interface CavemanState {
  defaults: CavemanDefaults;
  sessions: Record<string, Level>;
  lastNonOff: Level | null;
  readonly defaultsPath: string;
  readonly sessionsPath: string;
}

function readJson(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return undefined; // missing or unparseable -> caller falls back
  }
}

function isLevel(value: unknown): value is Level {
  return typeof value === "string" && (LEVELS as readonly string[]).includes(value);
}

/**
 * Load both sidecars. Corrupt or missing files fall back to `defaultLevel`
 * (itself defaulting to `full`); bad session entries are dropped and get
 * overwritten on the next level change. Never throws.
 */
export function loadState(dir: string): CavemanState {
  const defaultsPath = join(dir, "caveman.json");
  const sessionsPath = join(dir, "caveman_sessions.json");

  const raw = readJson(defaultsPath);
  const defaults: CavemanDefaults = {};
  if (typeof raw === "object" && raw !== null && !Array.isArray(raw)) {
    const src = raw as { enabled?: unknown; defaultMode?: unknown; features?: unknown; defaultLevel?: unknown };
    if (typeof src.enabled === "boolean") defaults.enabled = src.enabled;
    if (typeof src.defaultMode === "string") defaults.defaultMode = src.defaultMode;
    if (typeof src.features === "object" && src.features !== null && !Array.isArray(src.features)) {
      const features: Record<string, boolean> = {};
      for (const [key, value] of Object.entries(src.features as object)) {
        if (key === "__proto__") continue;
        if (typeof value === "boolean") features[key] = value;
      }
      defaults.features = features;
    }
    if (isLevel(src.defaultLevel)) defaults.defaultLevel = src.defaultLevel;
  }
  if (!isLevel(defaults.defaultLevel)) defaults.defaultLevel = "full";

  const rawSessions = readJson(sessionsPath);
  const sessions: Record<string, Level> = {};
  if (typeof rawSessions === "object" && rawSessions !== null && !Array.isArray(rawSessions)) {
    for (const [id, value] of Object.entries(rawSessions as object)) {
      if (id === "__proto__") continue;
      if (isLevel(value)) sessions[id] = value;
    }
  }

  let lastNonOff: Level | null = null;
  for (const level of Object.values(sessions)) if (level !== "off") lastNonOff = level;

  return { defaults, sessions, lastNonOff, defaultsPath, sessionsPath };
}

/** Extend caveman.json additively (task 3.1): sets defaultLevel, keeps the rest. */
export function persistDefaultLevel(state: CavemanState, level: Level): void {
  state.defaults.defaultLevel = level;
  writeFileSync(state.defaultsPath, JSON.stringify(state.defaults, null, 2) + "\n");
}

/** Persist a per-session override and refresh the toggle memory. */
export function persistSessionLevel(state: CavemanState, sessionID: string, level: Level): void {
  state.sessions[sessionID] = level;
  state.lastNonOff = level !== "off" ? level : state.lastNonOff;
  writeFileSync(state.sessionsPath, JSON.stringify(state.sessions, null, 2) + "\n");
}

/** Active level for a session: stored override, else defaultLevel. */
export function levelFor(state: CavemanState, sessionID?: string): Level {
  if (sessionID && Object.hasOwn(state.sessions, sessionID)) {
    const found: unknown = state.sessions[sessionID];
    if (isLevel(found)) return found;
  }
  return state.defaults.defaultLevel ?? "full";
}

// --- Plugin wiring (task 4) -------------------------------------------------

/** Read the state directory off setup context without a type cast. */
function resolveStateDir(ctx: unknown): string {
  const location: unknown =
    typeof ctx === "object" && ctx !== null ? Reflect.get(ctx, "location") : undefined;
  const directory: unknown =
    typeof location === "object" && location !== null ? Reflect.get(location, "directory") : undefined;
  return typeof directory === "string" ? directory : homedir();
}

function configMessage(state: CavemanState): string {
  return (
    `caveman config — defaultLevel: ${state.defaults.defaultLevel}. ` +
    `Valid levels: ${LEVELS.join(", ")}; aliases stop/quit -> off. ` +
    `New sessions inherit defaultLevel (edit ~/.config/opencode/caveman.json); each session remembers its own level.`
  );
}

export default Plugin.define({
  id: "caveman",
  async setup(ctx) {
    // Load state BEFORE registering transforms (transforms are synchronous,
    // replayable edits; the closure captures the loaded state).
    const stateDir = resolveStateDir(ctx);
    const state = loadState(stateDir);

    // Task 4.1 — own the /caveman command. V2 has no command.execute.before
    // hook; execute returns Promise<void>, so feedback is sent from inside via
    // ctx.session.synthetic({ sessionID, text }) (see §1 signature quote above).
    await ctx.command.transform((editor) => {
      editor.add({
        name: "caveman",
        description: "Set terseness level: lite|full|ultra|wenyan-lite|wenyan|wenyan-ultra|micro|off|stop|quit|config; bare toggles",
        execute: async ({ sessionID, prompt }) => {
          const arg = typeof prompt?.text === "string" ? prompt.text.trim() : "";
          // 0..1 args: split on whitespace, first token only.
          const first = arg.length > 0 ? arg.split(/\s+/)[0] : undefined;

          if (first === "config") {
            await ctx.session.synthetic({ sessionID, text: configMessage(state) });
            return;
          }

          const resolved = first === undefined ? "toggle" : resolveInput(first);

          if (resolved === null) {
            if (typeof first === "string") {
              const result = validateLevel(first);
              if (result.error !== undefined) {
                await ctx.session.synthetic({ sessionID, text: result.error });
              }
            }
            return; // state unchanged (spec: unknown input rejected)
          }

          const current = levelFor(state, sessionID);
          const next = resolved === "toggle" ? toggleLevel(current, state.lastNonOff) : resolved;
          try {
            persistSessionLevel(state, sessionID, next);
          } catch (error) {
            console.error("[caveman] persist session level failed", error);
          }
          await ctx.session.synthetic({ sessionID, text: `caveman ${next}` });
        },
      });
    });

    // Task 4.2 — inject the active level text on every agent turn.
    // try/catch: a broken hook must never break the turn (spec).
    await ctx.session.hook("context", (e) => {
      try {
        const text = buildPrompt(levelFor(state, e.sessionID));
        if (text) {
          e.system.push({ type: "text", text });
        }
      } catch (error) {
        console.error("[caveman] context hook failed", error);
      }
    });

    // Task 4.3 — compaction passthrough: push the same text to e.system so
    // summaries preserve style; NEVER assign e.result (that skips the
    // summarizer and orphans the resumed session).
    await ctx.session.hook("compaction", (e) => {
      try {
        const text = buildPrompt(levelFor(state, e.sessionID));
        if (text) {
          e.system.push({ type: "text", text });
        }
      } catch (error) {
        console.error("[caveman] compaction hook failed", error);
      }
    });

    console.log("[caveman] loaded"); // startup marker (design.md Migration Plan)

    return () => {
      // Cleanup on unload (replaces V1 dispose).
      console.log("[caveman] unloaded");
    };
  },
});
