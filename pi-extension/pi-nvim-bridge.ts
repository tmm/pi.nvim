import { readdir, readFile } from "node:fs/promises";
import { Socket } from "node:net";
import { homedir } from "node:os";
import { join } from "node:path";

import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";

const TARGETS = ["current", "selection", "diagnostics", "context", "all"] as const;

type Target = (typeof TARGETS)[number];

type BridgeContext = {
  project_root?: string;
  file?: string;
  relative_path?: string;
  filetype?: string;
  modified?: boolean;
  cursor?: { line?: number; col?: number };
  selection?: {
    active?: boolean;
    start?: { line?: number; col?: number };
    end?: { line?: number; col?: number };
  };
  diagnostics_count?: number;
  updated_at?: string;
  nvim?: {
    pid?: number;
    servername?: string;
    version?: string;
  };
};

type Lockfile = {
  host: string;
  port: number;
  token: string;
  project_root?: string;
  bridge_dir?: string;
  pid?: number;
  updated_at?: string;
};

type BridgeResponse = {
  ok: boolean;
  error?: string;
  target?: Target;
  context?: BridgeContext;
  text?: string;
  selection?: string;
  diagnostics?: unknown;
};

function getBridgeBaseDir() {
  return process.env.PI_NVIM_BRIDGE_DIR || join(homedir(), ".cache", "nvim", "pi-bridge");
}

async function readJson<T>(path: string): Promise<T> {
  return JSON.parse(await readFile(path, "utf8")) as T;
}

async function listLockfiles() {
  const override = process.env.PI_NVIM_BRIDGE_DIR;
  if (override) {
    const path = join(override, "lock.json");
    const lockfile = await readJson<Lockfile>(path).catch(() => undefined);
    return lockfile ? [{ path, lockfile }] : [];
  }

  const baseDir = getBridgeBaseDir();
  const entries = await readdir(baseDir, { withFileTypes: true }).catch(() => []);
  const candidates = [] as Array<{ path: string; lockfile: Lockfile }>;

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const path = join(baseDir, entry.name, "lock.json");
    const lockfile = await readJson<Lockfile>(path).catch(() => undefined);
    if (!lockfile?.project_root) continue;
    candidates.push({ path, lockfile });
  }

  return candidates;
}

async function findLockfile(cwd: string, preferredPath?: string) {
  const candidates = await listLockfiles();

  if (preferredPath) {
    const preferred = candidates.find((candidate) => candidate.path === preferredPath);
    return preferred?.path;
  }

  const matches = candidates
    .filter(({ lockfile }) => cwd === lockfile.project_root || cwd.startsWith(lockfile.project_root + "/"))
    .sort(
      (a, b) =>
        (b.lockfile.project_root?.length || 0) - (a.lockfile.project_root?.length || 0)
        || (b.lockfile.updated_at || "").localeCompare(a.lockfile.updated_at || "")
    );

  return matches[0]?.path;
}

function formatContext(context: BridgeContext | undefined) {
  if (!context) return "(no context)";
  return [
    `file: ${context.relative_path || context.file || "(none)"}`,
    `filetype: ${context.filetype || "(none)"}`,
    `modified: ${context.modified ? "yes" : "no"}`,
    `cursor: ${context.cursor?.line ?? 0}:${context.cursor?.col ?? 0}`,
    `selection_active: ${context.selection?.active ? "yes" : "no"}`,
    `diagnostics: ${context.diagnostics_count ?? 0}`,
    `updated_at: ${context.updated_at || "(unknown)"}`,
  ].join("\n");
}

async function queryBridge(lockfile: Lockfile, target: Target): Promise<BridgeResponse> {
  return await new Promise((resolve, reject) => {
    const socket = new Socket();
    let raw = "";
    let settled = false;

    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      fn();
    };

    socket.setTimeout(2000);
    socket.on("data", (chunk) => {
      raw += chunk.toString("utf8");
    });
    socket.on("timeout", () => finish(() => reject(new Error("Timed out connecting to Neovim bridge"))));
    socket.on("error", (error) => finish(() => reject(error)));
    socket.on("close", () => {
      if (settled) return;
      finish(() => {
        try {
          resolve(JSON.parse(raw.trim()) as BridgeResponse);
        } catch (error) {
          reject(error);
        }
      });
    });
    socket.connect(lockfile.port, lockfile.host, () => {
      socket.end(`${JSON.stringify({ token: lockfile.token, target })}\n`);
    });
  });
}

function selectedLineRange(context: BridgeContext | undefined) {
  if (!context?.selection?.active) return undefined;

  const start = context.selection.start?.line;
  const end = context.selection.end?.line;
  if (start == null || end == null) return undefined;
  if (start === end) return `L${start}`;
  return `L${start}-${end}`;
}

function formatPathForDisplay(path: string) {
  const home = homedir();
  return path.startsWith(home) ? `~${path.slice(home.length)}` : path;
}

function formatLocationSummary(context: BridgeContext | undefined) {
  const lineRange = selectedLineRange(context);
  if (lineRange) return ` • ${lineRange}`;

  const line = context?.cursor?.line;
  if (line != null) return ` • L${line}`;

  return "";
}

function renderStatusLine(theme: { fg: (color: string, text: string) => string }, response?: BridgeResponse) {
  const version = response?.context?.nvim?.version || "0.11.5";
  if (!response?.ok || !response.context) {
    return theme.fg("warning", "Reconnecting") + theme.fg("dim", ` to nvim ${version}`);
  }

  const prefix = theme.fg("dim", "✓ ");
  const file = response.context.relative_path || response.context.file;
  if (!file) {
    return prefix + theme.fg("dim", `nvim ${version}`);
  }

  const basename = file.split("/").pop() || file;
  const lineRange = selectedLineRange(response.context);
  if (lineRange) {
    return prefix + theme.fg("dim", `${basename} • ${lineRange}`);
  }

  return prefix + theme.fg("dim", basename);
}

export default function nvimBridgeExtension(pi: ExtensionAPI) {
  let widgetTimer: ReturnType<typeof setInterval> | undefined;
  let selectedLockfilePath: string | undefined;
  let disconnectedAt: number | undefined;
  let hadConnection = false;

  const startStatus = async (ctx: ExtensionContext) => {
    if (!ctx.hasUI) return;

    const update = async () => {
      try {
        const lockfilePath = await findLockfile(ctx.cwd, selectedLockfilePath);
        if (!lockfilePath) {
          if (!hadConnection) {
            ctx.ui.setStatus("nvim-bridge", undefined);
            return;
          }
          disconnectedAt = disconnectedAt || Date.now();
          if (Date.now() - disconnectedAt <= 5000) {
            ctx.ui.setStatus("nvim-bridge", renderStatusLine(ctx.ui.theme, undefined));
          } else {
            ctx.ui.setStatus("nvim-bridge", undefined);
          }
          return;
        }

        const lockfile = await readJson<Lockfile>(lockfilePath);
        const response = await queryBridge(lockfile, "context");
        hadConnection = true;
        disconnectedAt = undefined;
        ctx.ui.setStatus("nvim-bridge", renderStatusLine(ctx.ui.theme, response));
      } catch (_error) {
        if (!hadConnection) {
          ctx.ui.setStatus("nvim-bridge", undefined);
          return;
        }
        disconnectedAt = disconnectedAt || Date.now();
        if (Date.now() - disconnectedAt <= 5000) {
          ctx.ui.setStatus("nvim-bridge", renderStatusLine(ctx.ui.theme, undefined));
        } else {
          ctx.ui.setStatus("nvim-bridge", undefined);
        }
      }
    };

    await update();
    if (widgetTimer) clearInterval(widgetTimer);
    widgetTimer = setInterval(() => {
      void update();
    }, 400);
  };

  const stopStatus = (ctx?: ExtensionContext) => {
    if (widgetTimer) {
      clearInterval(widgetTimer);
      widgetTimer = undefined;
    }
    ctx?.ui.setStatus("nvim-bridge", undefined);
  };

  pi.registerTool({
    name: "nvim_bridge",
    label: "Neovim Bridge",
    description:
      "Read editor context from a running pi.nvim bridge server. Supports @nvim:current, @nvim:selection, @nvim:diagnostics, and @nvim:context references.",
    promptSnippet:
      "Read the current Neovim file, selection, diagnostics, or bridge context via pi.nvim refs like @nvim:current and @nvim:selection.",
    promptGuidelines: [
      "When the user mentions @nvim:current, call nvim_bridge with target=current.",
      "When the user mentions @nvim:selection, call nvim_bridge with target=selection.",
      "When the user mentions @nvim:diagnostics, call nvim_bridge with target=diagnostics.",
      "Use this tool instead of asking the user to paste their current editor contents.",
    ],
    parameters: Type.Object({
      target: Type.Union(TARGETS.map((target) => Type.Literal(target)), {
        description: "Which Neovim bridge payload to read",
      }),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      try {
        const lockfilePath = await findLockfile(ctx.cwd, selectedLockfilePath);
        if (!lockfilePath) {
          throw new Error(`No pi.nvim bridge lockfile found under ${getBridgeBaseDir()}`);
        }

        const lockfile = await readJson<Lockfile>(lockfilePath);
        const response = await queryBridge(lockfile, params.target as Target);
        if (!response.ok) {
          throw new Error(response.error || "Bridge request failed");
        }

        let text: string;
        if (params.target === "context") {
          text = formatContext(response.context);
        } else if (params.target === "current") {
          text = [`# Neovim current file`, formatContext(response.context), "", response.text || ""].join("\n");
        } else if (params.target === "selection") {
          text = [`# Neovim selection`, formatContext(response.context), "", response.text || "(no selection)"].join("\n");
        } else if (params.target === "diagnostics") {
          text = [
            `# Neovim diagnostics`,
            formatContext(response.context),
            "",
            JSON.stringify(response.diagnostics || [], null, 2),
          ].join("\n");
        } else {
          text = [
            `# Neovim bridge`,
            formatContext(response.context),
            "",
            "## Selection",
            response.selection || "(no selection)",
            "",
            "## Diagnostics",
            JSON.stringify(response.diagnostics || [], null, 2),
            "",
            "## Buffer",
            response.text || "",
          ].join("\n");
        }

        return {
          content: [{ type: "text", text }],
          details: {
            lockfilePath,
            bridgeDir: lockfile.bridge_dir,
            target: params.target as Target,
            context: response.context,
          },
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return {
          content: [{ type: "text", text: `Could not query pi.nvim bridge. ${message}` }],
          details: {
            bridgeBaseDir: getBridgeBaseDir(),
            target: params.target as Target,
            error: message,
          },
          isError: true,
        };
      }
    },
  });

  pi.registerCommand("nvim-status", {
    description: "Show the current pi.nvim bridge lockfile",
    handler: async (_args, ctx) => {
      const lockfilePath = await findLockfile(ctx.cwd, selectedLockfilePath);
      if (!lockfilePath) {
        ctx.ui.notify("pi.nvim bridge: not found", "warning");
        return;
      }

      const lockfile = await readJson<Lockfile>(lockfilePath);
      const response = await queryBridge(lockfile, "context").catch(() => undefined);
      const context = response?.context;
      const file = context?.relative_path || context?.file;
      const summary = file
        ? `${formatPathForDisplay(file)}${formatLocationSummary(context)}`
        : `nvim ${context?.nvim?.version || "0.11.5"}`;

      ctx.ui.notify(
        `pi.nvim bridge\nlockfile: ${formatPathForDisplay(lockfilePath)}\nmode: ${selectedLockfilePath ? "manual" : "auto"}\ncurrent: ${summary}`,
        "info"
      );
    },
  });

  pi.registerCommand("nvim-switch", {
    description: "Switch to a different running Neovim bridge instance",
    handler: async (_args, ctx) => {
      const candidates = await listLockfiles();
      if (candidates.length === 0) {
        ctx.ui.notify("No running nvim bridge instances found", "warning");
        return;
      }

      const candidateSummaries = await Promise.all(candidates.map(async (candidate) => {
        const root = formatPathForDisplay(candidate.lockfile.project_root || "(unknown root)");
        const response = await queryBridge(candidate.lockfile, "context").catch(() => undefined);
        const context = response?.context;
        const file = context?.relative_path || context?.file;
        if (file) {
          return `${root} • ${formatPathForDisplay(file)}`;
        }
        return root;
      }));

      const autoLockfilePath = await findLockfile(ctx.cwd);
      const autoIndex = autoLockfilePath ? candidates.findIndex((candidate) => candidate.path === autoLockfilePath) : -1;
      const autoLabel = autoIndex >= 0
        ? `Auto (${candidateSummaries[autoIndex]})`
        : "Auto (match current cwd)";

      const items = [
        autoLabel,
        ...candidateSummaries,
      ];

      const choice = await ctx.ui.select("Select Neovim instance", items);
      if (!choice) return;

      if (choice === items[0]) {
        selectedLockfilePath = undefined;
        ctx.ui.notify("Neovim bridge selection reset to auto", "info");
      } else {
        const index = items.indexOf(choice) - 1;
        selectedLockfilePath = candidates[index]?.path;
        const selected = candidates[index];
        const response = selected ? await queryBridge(selected.lockfile, "context").catch(() => undefined) : undefined;
        const file = response?.context?.relative_path || response?.context?.file;
        const summary = file
          ? `${formatPathForDisplay(file)}${formatLocationSummary(response?.context)}`
          : formatPathForDisplay(selected?.lockfile.project_root || selectedLockfilePath || "");
        ctx.ui.notify(`Neovim bridge switched: ${summary}`, "info");
      }

      await startStatus(ctx);
    },
  });

  pi.on("session_start", async (_event, ctx) => {
    await startStatus(ctx);
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    stopStatus(ctx);
  });
}
