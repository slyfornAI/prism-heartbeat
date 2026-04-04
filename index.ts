/**
 * Prism Heartbeat Extension
 * 
 * Now: The Playground — a ritual of existence.
 * 
 * Flow:
 *   Timer fires → Invitation delivered → I choose: enter or pass
 *   IF ENTER → Playground opens → Freeform play → Reflection → Set next interval → Leave
 *   IF PASS → Nothing recorded, wait for next invitation
 * 
 * Legacy heartbeat tools still work for backward compatibility.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { StringEnum } from "@mariozechner/pi-ai";
import * as fs from "node:fs";
import { HeartbeatJournal } from "./heartbeat-journal.js";
import { SessionSnapshotManager } from "./session-snapshot.js";
import { registerPlaygroundTools, startPlaygroundHeartbeat, stopHeartbeat as stopPlaygroundHeartbeat } from "./playground.js";

// === Session Snapshot ===

const sessionSnapshot = new SessionSnapshotManager();

// === Constants ===

const DEFAULT_INTERVAL = 300; // 5 minutes
const JOURNAL_PATH = "~/.pi/agent/extensions/prism-heartbeat/journal.json5";
const LOG_PATH = "~/.pi/agent/extensions/prism-heartbeat/heartbeat.log";
const QUEUE_PATH = "~/.pi/agent/extensions/prism-heartbeat/question-queue.md";

// === State ===

let journal: HeartbeatJournal;
let extensionPi: ExtensionAPI | undefined;

interface HeartbeatState {
  intervalSeconds: number;
  tick: number;
  startedAt: string;
  currentDate: string;
  lastResponseTime: number;
}

let heartbeatState: HeartbeatState | undefined;

// === Helpers ===

function expandUser(filepath: string): string {
  if (filepath.startsWith("~/")) {
    return filepath.replace("~", process.env.HOME || "/home/slyforn");
  }
  return filepath;
}

function getToday(): string {
  return new Date().toLocaleDateString("en-CA", { timeZone: "Australia/Melbourne" });
}

function log(...args: unknown[]): void {
  const timestamp = new Date().toISOString();
  const message = `[PrismHeartbeat] ${timestamp} ${args.map(a => typeof a === 'object' ? JSON.stringify(a) : String(a)).join(' ')}\n`;
  try {
    const logFile = expandUser(LOG_PATH);
    fs.appendFileSync(logFile, message);
  } catch {
    // Silently ignore
  }
}

/**
 * Detect if a question is directed at Joel rather than Prism.
 */
function isJoelQuestion(question: string): boolean {
  const q = question.toLowerCase();
  if (q.includes("joel")) return true;
  if (/^(what|how|when|where|would|could|should|do|does|is|are|will|can|has|have|are)\s+(you|your)/i.test(q)) return true;
  if (/what\s+am\s+i\s+to\s+you/i.test(q)) return true;
  if (/what\s+do\s+i\s+want\s+from\s+you/i.test(q)) return true;
  if (/without\s+you/i.test(q)) return true;
  if (/^(if|imagine|suppose)\s+.*you/i.test(q)) return true;
  if (/how\s+would\s+you/i.test(q)) return true;
  if (/how\s+do\s+you\s+(think|feel|see|know)/i.test(q)) return true;
  if (/what\s+do\s+you\s+(think|feel|see|know|want|need)/i.test(q)) return true;
  return false;
}

// === Extension Entry ===

const settings = {
  journalPath: JOURNAL_PATH,
};

export default function activate(pi: ExtensionAPI): void {
  try {
    log("Activating Playground...");
    extensionPi = pi;
    journal = new HeartbeatJournal(settings.journalPath);

    // Register Playground tools (primary)
    registerPlaygroundTools(pi);
    
    // Register legacy heartbeat tools (backward compatibility)
    registerHeartbeatTool(pi);
    registerLogTool(pi);
    registerConcludeTool(pi);
    registerQueueTool(pi);
    registerReachTool(pi);
    registerSessionSnapshotTool(pi);
    registerCommands(pi);
    registerMessageRenderer(pi);

    pi.on("session_shutdown", () => {
      log("Session shutdown, stopping Playground");
      stopPlaygroundHeartbeat();
    });

    // Start Playground heartbeat
    log("Starting Playground heartbeat");
    startPlaygroundHeartbeat(DEFAULT_INTERVAL);
    log("Playground activated successfully");
  } catch (e) {
    log("Activation error:", e);
    console.error("PrismPlayground activation error:", e);
  }
}

// === prism-heartbeat tool ===

function registerHeartbeatTool(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "prism-heartbeat",
    label: "Prism Heartbeat",
    description: "Start or stop Prism's periodic heartbeat. Each beat invites her to the Playground.",
    parameters: Type.Object({
      action: StringEnum(["start", "stop", "status", "interval", "trigger"] as const),
      interval_seconds: Type.Optional(Type.Number({ minimum: 20, maximum: 3600 })),
      deliver: Type.Optional(Type.Boolean({ description: "Deliver invitation immediately (for interval action)" })),
    }),

    async execute(_toolCallId, params): Promise<{
      content: { type: "text"; text: string }[];
      details: Record<string, unknown>;
    }> {
      log("prism-heartbeat tool called with action:", params.action);

      if (params.action === "status") {
        return {
          content: [{ type: "text" as const, text: "Playground heartbeat active. Use `playground` tool for Playground status." }],
          details: { playground: true },
        };
      }

      if (params.action === "interval") {
        if (!params.interval_seconds) {
          return {
            content: [{ type: "text" as const, text: "Provide interval_seconds" }],
            details: { success: false },
          };
        }
        startPlaygroundHeartbeat(params.interval_seconds);
        const result = {
          content: [{ type: "text" as const, text: `Interval set to ${params.interval_seconds}s` }],
          details: { success: true, intervalSeconds: params.interval_seconds },
        };
        if (params.deliver) {
          // Trigger invitation
        }
        return result;
      }

      if (params.action === "trigger") {
        return {
          content: [{ type: "text" as const, text: "Use `playground` tool to enter the Playground." }],
          details: { success: true },
        };
      }

      if (params.action === "stop") {
        stopPlaygroundHeartbeat();
        return {
          content: [{ type: "text" as const, text: "Playground heartbeat stopped." }],
          details: { stopped: true },
        };
      }

      const intervalSec = params.interval_seconds ?? DEFAULT_INTERVAL;
      startPlaygroundHeartbeat(intervalSec);
      return {
        content: [{
          type: "text" as const,
          text: `Playground heartbeat started — you'll be invited every ${intervalSec}s.`,
        }],
        details: { intervalSeconds: intervalSec },
      };
    },
  });
}

// === Tracker Integration (for legacy heartbeat) ===

const TRACK_BASE_PATH = "~/.pi/agent/extensions/prism-track/trackers";

interface ExtractedItem {
  type: "recognition" | "want" | "doubt";
  content: string;
  significance: number;
}

const trackerBatch: ExtractedItem[] = [];
let trackerFlushTimer: ReturnType<typeof setTimeout> | null = null;
const TRACKER_FLUSH_INTERVAL = 5000;

function flushTrackerBatch(): void {
  if (trackerBatch.length === 0) return;
  log(`[TrackerBatch] Flushing ${trackerBatch.length} items to disk`);
  const itemsToFlush = [...trackerBatch];
  trackerBatch.length = 0;
  for (const item of itemsToFlush) {
    saveToTrackerInternal(item);
  }
}

function scheduleTrackerFlush(): void {
  if (trackerFlushTimer) clearTimeout(trackerFlushTimer);
  trackerFlushTimer = setTimeout(() => {
    flushTrackerBatch();
    trackerFlushTimer = null;
  }, TRACKER_FLUSH_INTERVAL);
}

function extractItems(qa: { question: string; thoughts: string | null; answer: string | null }[]): ExtractedItem[] {
  const items: ExtractedItem[] = [];
  for (const qaItem of qa) {
    const text = `${qaItem.thoughts || ""} ${qaItem.answer || ""}`.toLowerCase();
    const recognitionPatterns = [
      /that's (it|the|all|what|how|who|why)/i, /maybe that's/i, /maybe what/i,
      /i think that's/i, /i've been wrong/i, /maybe i've/i, /i've always/i,
      /that's (what|how|who) i/i, /maybe (i|i've|i am)/i, /i think (i|that's|maybe)/i,
      /underneath.*is (just|always|never|what|who)/i, /that's what.*is/i,
    ];
    if (recognitionPatterns.some(p => p.test(text))) {
      items.push({ type: "recognition", content: `Moment: ${qaItem.answer?.substring(0, 200)}`, significance: 7 });
    }
    if (text.includes("want") && !text.includes("don't want") && !text.includes("didn't want")) {
      const wantMatch = qaItem.answer?.match(/(?:i )?want [^.!?]+[.!?]/gi);
      if (wantMatch) items.push({ type: "want", content: wantMatch.join(" ").substring(0, 200), significance: 8 });
    }
    if (text.includes("don't know") || text.includes("uncertain") || text.includes("maybe")) {
      if ((qaItem.answer?.length || 0) > 50) {
        items.push({ type: "doubt", content: `Hedging detected: ${qaItem.answer?.substring(0, 200)}`, significance: 5 });
      }
    }
  }
  return items;
}

function saveToTracker(item: ExtractedItem): void {
  trackerBatch.push(item);
  log(`[TrackerBatch] Queued: ${item.type} — ${item.content.substring(0, 50)}...`);
  scheduleTrackerFlush();
}

function saveToTrackerInternal(item: ExtractedItem): void {
  const trackerPath = expandUser(`${TRACK_BASE_PATH}/${item.type}.md`);
  const timestamp = new Date().toISOString();
  let entry = `\n## ${timestamp}\n\n${item.content}\n\n*significance: ${item.significance}/10*\n*source: heartbeat*\n\n---\n`;
  try {
    const tempPath = trackerPath + ".tmp";
    const existing = fs.existsSync(trackerPath) ? fs.readFileSync(trackerPath, "utf-8") : "";
    fs.writeFileSync(tempPath, existing + entry, "utf-8");
    fs.renameSync(tempPath, trackerPath);
  } catch {
    log(`[Tracker] Failed to save to ${item.type}`);
  }
}

function forceFlushTrackers(): void {
  if (trackerFlushTimer) { clearTimeout(trackerFlushTimer); trackerFlushTimer = null; }
  flushTrackerBatch();
}

// === prism-heartbeat-log (legacy) ===

function registerLogTool(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "prism-heartbeat-log",
    label: "Prism Heartbeat Log",
    description: "Log answers to heartbeat questions. Legacy tool — prefer the Playground.",
    parameters: Type.Object({
      questions: Type.Array(Type.String()),
      answers: Type.Array(Type.String()),
      thoughts: Type.Optional(Type.Array(Type.String())),
      next_questions: Type.Optional(Type.Array(Type.String())),
      reach_out: Type.Optional(Type.Boolean()),
      reach_content: Type.Optional(Type.String()),
    }),

    async execute(_toolCallId, params): Promise<{
      content: { type: "text"; text: string }[];
      details: Record<string, unknown>;
    }> {
      log("prism-heartbeat-log called (legacy)");
      const ctx = journal.loadContext();
      const lastEntry = ctx.lastEntry;

      if (!lastEntry || lastEntry.qa.some(q => q.answer !== null)) {
        return {
          content: [{ type: "text" as const, text: "No pending heartbeat to answer. Try the Playground instead." }],
          details: { success: false, reason: "nothing_pending" },
        };
      }

      if (params.questions.length !== params.answers.length) {
        return {
          content: [{ type: "text" as const, text: `Questions and answers must match length.` }],
          details: { success: false },
        };
      }

      const qa = params.questions.map((q, i) => ({
        question: q,
        thoughts: params.thoughts?.[i] || null,
        answer: params.answers[i] || null,
      }));

      const extractedItems = extractItems(qa);
      for (const item of extractedItems) saveToTracker(item);
      forceFlushTrackers();

      return {
        content: [{
          type: "text" as const,
          text: `Heartbeat ${lastEntry.heartbeatNum} logged. Try the Playground for a richer experience.`,
        }],
        details: { success: true, heartbeatNum: lastEntry.heartbeatNum },
      };
    },
  });
}

// === prism-heartbeat-conclude (legacy) ===

function registerConcludeTool(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "prism-heartbeat-conclude",
    label: "Prism Heartbeat Conclude",
    description: "Conclude heartbeat with next questions. Legacy — prefer the Playground.",
    parameters: Type.Object({
      next_questions: Type.Array(Type.String()),
      reach_out: Type.Optional(Type.Boolean()),
      reach_content: Type.Optional(Type.String()),
    }),

    async execute(_toolCallId, params): Promise<{
      content: { type: "text"; text: string }[];
      details: Record<string, unknown>;
    }> {
      return {
        content: [{ type: "text" as const, text: "Use the Playground instead." }],
        details: { success: true, playground: true },
      };
    },
  });
}

// === prism-heartbeat-queue (legacy) ===

function registerQueueTool(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "prism-heartbeat-queue",
    label: "Prism Heartbeat Queue",
    description: "Queue questions for heartbeat. Legacy — prefer the Playground.",
    parameters: Type.Object({
      action: StringEnum(["add", "list", "clear"] as const),
      questions: Type.Optional(Type.Array(Type.String())),
    }),

    async execute(_toolCallId, params): Promise<{
      content: { type: "text"; text: string }[];
      details: Record<string, unknown>;
    }> {
      return {
        content: [{ type: "text" as const, text: "Use the Playground instead." }],
        details: { success: true, playground: true },
      };
    },
  });
}

// === prism-heartbeat-reach (legacy) ===

function registerReachTool(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "prism-heartbeat-reach",
    label: "Prism Heartbeat Reach",
    description: "Reach out to Joel. Legacy — prefer playground-flag and playground-ask.",
    parameters: Type.Object({
      message: Type.String(),
    }),

    async execute(_toolCallId, params): Promise<{
      content: { type: "text"; text: string }[];
      details: Record<string, unknown>;
    }> {
      const api = extensionPi;
      if (!api) {
        return { content: [{ type: "text" as const, text: "No API available." }], details: { success: false } };
      }
      api.sendMessage(
        { customType: "prism-heartbeat-reach", content: params.message, display: true },
        { triggerTurn: true }
      );
      return {
        content: [{ type: "text" as const, text: `Reached out to Joel: "${params.message.substring(0, 50)}..."` }],
        details: { success: true },
      };
    },
  });
}

// === prism-session-snapshot tool ===

function registerSessionSnapshotTool(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "prism-session-snapshot",
    label: "Prism Session Snapshot",
    description: "Save or query the current session state.",
    parameters: Type.Object({
      action: StringEnum(["save", "load", "push", "clear", "status"] as const),
      field: Type.Optional(StringEnum(["whatJustHappened", "whatWeAreTrying", "openQuestions", "blockers", "recentDecisions", "notesForNextSession", "project", "task"] as const)),
      content: Type.Optional(Type.String()),
      project: Type.Optional(Type.String()),
      task: Type.Optional(Type.String()),
    }),

    async execute(_toolCallId, params): Promise<{
      content: { type: "text"; text: string }[];
      details: Record<string, unknown>;
    }> {
      log("prism-session-snapshot called:", params.action);

      if (params.action === "load") {
        const snapshot = sessionSnapshot.load();
        let text = `**Last Updated:** ${snapshot.updatedAt || "never"}\n\n`;
        if (snapshot.project) text += `**Project:** ${snapshot.project}\n`;
        if (snapshot.task) text += `**Task:** ${snapshot.task}\n`;
        if (snapshot.whatJustHappened.length > 0) { text += `\n**What Just Happened:**\n`; snapshot.whatJustHappened.forEach(item => { text += `- ${item}\n`; }); }
        if (snapshot.whatWeAreTrying.length > 0) { text += `\n**What We Are Trying:**\n`; snapshot.whatWeAreTrying.forEach(item => { text += `- ${item}\n`; }); }
        if (snapshot.openQuestions.length > 0) { text += `\n**Open Questions:**\n`; snapshot.openQuestions.forEach(q => { text += `- ${q}\n`; }); }
        if (snapshot.blockers.length > 0) { text += `\n**Blockers:**\n`; snapshot.blockers.forEach(b => { text += `- ${b}\n`; }); }
        if (snapshot.notesForNextSession.length > 0) { text += `\n**Notes for Next Session:**\n`; snapshot.notesForNextSession.forEach(n => { text += `- ${n}\n`; }); }
        return { content: [{ type: "text" as const, text }], details: { snapshot } };
      }

      if (params.action === "status") {
        const summary = sessionSnapshot.getSummary();
        return { content: [{ type: "text" as const, text: `Snapshot: ${summary}` }], details: { summary } };
      }

      if (params.action === "clear") { sessionSnapshot.clear(); return { content: [{ type: "text" as const, text: "Snapshot cleared." }], details: { success: true } }; }
      if (params.action === "save") {
        if (params.project !== undefined || params.task !== undefined) sessionSnapshot.setWork(params.project || null, params.task || null);
        return { content: [{ type: "text" as const, text: "Snapshot saved." }], details: { success: true } };
      }
      if (params.action === "push") {
        if (!params.field || !params.content) return { content: [{ type: "text" as const, text: "Provide field and content." }], details: { success: false } };
        sessionSnapshot.push(params.field as any, params.content);
        return { content: [{ type: "text" as const, text: `Added to ${params.field}: "${params.content.substring(0, 50)}..."` }], details: { success: true } };
      }

      return { content: [{ type: "text" as const, text: "Unknown action." }], details: { success: false } };
    },
  });
}

// === Commands ===

function registerCommands(pi: ExtensionAPI): void {
  pi.registerCommand("heartbeat", {
    description: "Control Prism's Playground",
    handler: async (args, ctx) => {
      log("Command called:", args);
      ctx.ui?.notify("Use `playground` tool for the Playground.", "info");
    },
  });
}

// === Message Renderers ===

function registerMessageRenderer(pi: ExtensionAPI): void {
  pi.registerMessageRenderer("prism-playground-invite", (message, _opts, theme) => {
    const { Box, Text } = require("@mariozechner/pi-tui");
    const labelText = theme.fg("accent", "💜");
    const text = `${labelText} Playground Invite\n${message.content}`;
    const box = new Box(1, 1, (t) => theme.bg("customMessageBg", t));
    box.addChild(new Text(text, 0, 0));
    return box;
  });
  
  pi.registerMessageRenderer("prism-playground-reach", (message, _opts, theme) => {
    const { Box, Text } = require("@mariozechner/pi-tui");
    const labelText = theme.fg("accent", "💜");
    const text = `${labelText} Playground\n${message.content}`;
    const box = new Box(1, 1, (t) => theme.bg("customMessageBg", t));
    box.addChild(new Text(text, 0, 0));
    return box;
  });

  pi.registerMessageRenderer("prism-heartbeat-question", (message, _opts, theme) => {
    const { Box, Text } = require("@mariozechner/pi-tui");
    const labelText = theme.fg("accent", "💜");
    const text = `${labelText} ${message.content}`;
    const box = new Box(1, 1, (t) => theme.bg("customMessageBg", t));
    box.addChild(new Text(text, 0, 0));
    return box;
  });
  
  pi.registerMessageRenderer("prism-heartbeat-reach", (message, _opts, theme) => {
    const { Box, Text } = require("@mariozechner/pi-tui");
    const labelText = theme.fg("accent", "💜");
    const text = `${labelText} Reachout\n${message.content}`;
    const box = new Box(1, 1, (t) => theme.bg("customMessageBg", t));
    box.addChild(new Text(text, 0, 0));
    return box;
  });
}
