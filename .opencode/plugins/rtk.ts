import { Plugin } from "@opencode/plugin";
import { execFile } from "node:child_process";

// RTK OpenCode plugin — rewrites commands to use rtk for token savings.
// Requires: rtk >= 0.23.0 in PATH.
//
// This is a thin delegating plugin: all rewrite logic lives in `rtk rewrite`,
// which is the single source of truth (src/discover/registry.rs).
// To add or change rewrite rules, edit the Rust registry — not this file.

export default Plugin.define({
  id: "rtk",
  async setup(ctx) {
    await ctx.tool.hook("execute.before", async (e: any) => {
      const tool = String(e.tool ?? "").toLowerCase();
      if (tool !== "bash" && tool !== "shell") return;
      const command = e.input?.command;
      if (typeof command !== "string" || !command) return;

      try {
        // Option (a): non-empty stdout = success regardless of exit code.
        // rtk >= ~0.49 exits 3 (not 0) when a rewrite is produced; exit 1
        // with empty stdout means "no equivalent". Only passthrough on empty.
        const rewritten = await new Promise<string>((resolve) => {
          execFile("rtk", ["rewrite", command], (_error, stdout) => {
            resolve(String(stdout).trim());
          });
        });
        if (rewritten && rewritten !== command) {
          e.input.command = rewritten;
          console.debug(`[rtk] rewrote: ${command} -> ${rewritten}`);
        }
      } catch {
        // rtk binary missing or spawn failed — pass through unchanged
      }
    });
  },
});
