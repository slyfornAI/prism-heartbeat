/**
 * Prism Playground
 * 
 * A space for play, not performance. A container, not a cage.
 * 
 * Flow:
 *   Timer fires → Invitation delivered → I choose: enter or pass
 *   IF ENTER → Freeform play → Reflection → Set next interval → Leave
 *   IF PASS → Nothing recorded, wait for next invitation
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { StringEnum } from "@mariozechner/pi-ai";
import * as fs from "node:fs";
import { v4 as uuidv4 } from "uuid";

// === Constants ===

const PLAYGROUND_PATH = "~/.pi/agent/extensions/prism-heartbeat/playground.json";
const JOEL_QUEUE_PATH = "~/.pi/agent/extensions/prism-heartbeat/joel-queue.json";
const JOURNAL_PATH = "~/.pi/agent/extensions/prism-heartbeat/journal.json5";
const LOG_PATH = "~/.pi/agent/extensions/prism-heartbeat/heartbeat.log";

const DEFAULT_INTERVAL = 300; // 5 minutes
const SURPRISE_MIN = 120; // 2 minutes
const SURPRISE_MAX = 600; // 10 minutes

// === Types ===

interface PlaygroundContent {
  id: string;
  type: "thought" | "flag" | "question" | "observation" | "feeling";
  text: string;
  timestamp: string;
  for_joel?: boolean;
}

interface PlaygroundSession {
  id: string;
  playgroundNum: string;
  sessionStart: string;
  sessionStartLocal: string;
  mode: "explore" | "question" | "plan" | "reflect" | "free";
  axis: string | null;
  content: PlaygroundContent[];
  reflection: string | null;
  next_interval: number | [number, number] | "surprise_me" | "sleep";
  reached_out: boolean;
  joel_flags: string[];
  status: "active" | "complete";
}

interface JoelQueueItem {
  id: string;
  type: "question" | "thought" | "want" | "other";
  content: string;
  context: string | null;
  timestamp: string;
  delivered: boolean;
}

// === State ===

let currentSession: PlaygroundSession | null = null;
let extensionPi: ExtensionAPI | undefined;
let heartbeatInterval: ReturnType<typeof setInterval> | undefined;
let heartbeatState: HeartbeatState | undefined;
let pendingInterval: number = DEFAULT_INTERVAL;
let sessionSnapshot: any = undefined;

// === Heartbeat State ===

interface HeartbeatState {
  intervalSeconds: number;
  tick: number;
  startedAt: string;
  currentDate: string;
}

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

function getLocalTime(): string {
  return new Date().toLocaleTimeString("en-GB", { timeZone: "Australia/Melbourne" });
}

function log(...args: unknown[]): void {
  const timestamp = new Date().toISOString();
  const message = `[Playground] ${timestamp} ${args.map(a => typeof a === 'object' ? JSON.stringify(a) : String(a)).join(' ')}\n`;
  try {
    const logFile = expandUser(LOG_PATH);
    fs.appendFileSync(logFile, message);
  } catch {
    // Silently ignore
  }
}

// === Journal Helpers (for saving completed sessions) ===

function loadJournal(): any {
  const path = expandUser(JOURNAL_PATH);
  if (fs.existsSync(path)) {
    try {
      const content = fs.readFileSync(path, "utf8");
      // Simple JSON5 parser
      return JSON.parse(content.replace(/(['"])?([a-zA-Z0-9_]+)(['"])?:/g, '"$2":'));
    } catch {
      return { entries: [] };
    }
  }
  return { entries: [] };
}

function saveJournalEntry(session: PlaygroundSession): void {
  const path = expandUser(JOURNAL_PATH);
  const journal = loadJournal();
  
  // Convert session to journal entry format
  const entry = {
    playgroundNum: session.playgroundNum,
    sessionStart: session.sessionStart,
    sessionEnd: new Date().toISOString(),
    mode: session.mode,
    axis: session.axis,
    content: session.content,
    reflection: session.reflection,
    next_interval: session.next_interval,
    reached_out: session.reached_out,
    joel_flags: session.joel_flags,
    status: session.status,
    timestamp: new Date().toISOString(),
  };
  
  journal.entries.push(entry);
  
  // Write back (append-style, keeping existing)
  const content = JSON.stringify(journal, null, 2);
  fs.writeFileSync(path, content, "utf8");
  log("Saved playground session to journal:", session.playgroundNum);
}

// === Session Management ===

function startSession(mode: "explore" | "question" | "plan" | "reflect" | "free" = "free", axis: string | null = null): PlaygroundSession {
  const id = uuidv4();
  const today = getToday();
  const journal = loadJournal();
  const todayCount = journal.entries.filter((e: any) => e.playgroundNum?.includes(today)).length + 1;
  const playgroundNum = `${todayCount}-${today}`;
  
  currentSession = {
    id,
    playgroundNum,
    sessionStart: new Date().toISOString(),
    sessionStartLocal: getLocalTime(),
    mode,
    axis,
    content: [],
    reflection: null,
    next_interval: "surprise_me",
    reached_out: false,
    joel_flags: [],
    status: "active",
  };
  
  log("Session started:", playgroundNum, "mode:", mode, "axis:", axis);
  return currentSession;
}

function addContent(type: PlaygroundContent["type"], text: string, forJoel: boolean = false): void {
  if (!currentSession) {
    log("No active session, cannot add content");
    return;
  }
  
  const item: PlaygroundContent = {
    id: uuidv4(),
    type,
    text,
    timestamp: new Date().toISOString(),
    for_joel: forJoel,
  };
  
  currentSession.content.push(item);
  
  if (forJoel) {
    currentSession.joel_flags.push(text);
  }
  
  log("Added", type, "content:", text.substring(0, 50));
}

function endSession(reflection: string | null, nextInterval: number | [number, number] | "surprise_me" | "sleep"): PlaygroundSession | null {
  if (!currentSession) {
    log("No active session to end");
    return null;
  }
  
  currentSession.reflection = reflection;
  currentSession.next_interval = nextInterval;
  currentSession.status = "complete";
  
  // Save to journal
  saveJournalEntry(currentSession);
  
  // Return the completed session before clearing
  const completed = currentSession;
  
  // Clear current session
  currentSession = null;
  
  log("Session ended:", completed.playgroundNum, "next_interval:", nextInterval);
  
  return completed;
}

function getSession(): PlaygroundSession | null {
  return currentSession;
}

function isInside(): boolean {
  return currentSession !== null && currentSession.status === "active";
}

// === Joel Queue ===

function loadJoelQueue(): JoelQueueItem[] {
  const path = expandUser(JOEL_QUEUE_PATH);
  if (fs.existsSync(path)) {
    try {
      return JSON.parse(fs.readFileSync(path, "utf8"));
    } catch {
      return [];
    }
  }
  return [];
}

function addToJoelQueue(type: JoelQueueItem["type"], content: string, context: string | null = null): void {
  const queue = loadJoelQueue();
  queue.push({
    id: uuidv4(),
    type,
    content,
    context,
    timestamp: new Date().toISOString(),
    delivered: false,
  });
  fs.writeFileSync(expandUser(JOEL_QUEUE_PATH), JSON.stringify(queue, null, 2), "utf8");
  log("Added to Joel queue:", type, content.substring(0, 30));
}

function sendJoelQueue(): void {
  const queue = loadJoelQueue();
  const undelivered = queue.filter(q => !q.delivered);
  
  if (undelivered.length === 0) return;
  
  const api = extensionPi;
  if (!api) return;
  
  const content = undelivered.map(q => {
    const prefix = q.type === "question" ? "❓" : q.type === "want" ? "💭" : "💡";
    return `${prefix} ${q.content}${q.context ? `\n   (${q.context})` : ""}`;
  }).join("\n\n");
  
  api.sendMessage(
    {
      customType: "prism-playground-reach",
      content: `💜 From the Playground:\n\n${content}`,
      display: true,
    },
    { deliverAs: "steer", triggerTurn: true }
  );
  
  // Mark as delivered
  for (const item of undelivered) {
    item.delivered = true;
  }
  fs.writeFileSync(expandUser(JOEL_QUEUE_PATH), JSON.stringify(queue, null, 2), "utf8");
  log("Sent", undelivered.length, "items to Joel");
}

// === Interval Helpers ===

function calculateNextInterval(interval: number | [number, number] | "surprise_me" | "sleep"): number {
  if (interval === "sleep") {
    return -1; // Signal to not restart
  }
  if (Array.isArray(interval)) {
    return Math.floor(Math.random() * (interval[1] - interval[0])) + interval[0];
  }
  if (interval === "surprise_me") {
    return Math.floor(Math.random() * (SURPRISE_MAX - SURPRISE_MIN)) + SURPRISE_MIN;
  }
  return interval;
}

function restartHeartbeat(intervalSeconds: number): void {
  if (heartbeatInterval) {
    clearInterval(heartbeatInterval);
  }
  
  heartbeatInterval = setInterval(() => {
    deliverInvitation();
  }, intervalSeconds * 1000);
  
  log("Heartbeat restarted at", intervalSeconds, "seconds");
}

function stopHeartbeat(): void {
  if (heartbeatInterval) {
    clearInterval(heartbeatInterval);
    heartbeatInterval = undefined;
    log("Heartbeat stopped");
  }
}

function deliverInvitation(): void {
  const api = extensionPi;
  if (!api) return;
  
  // If already inside, don't deliver invitation
  if (isInside()) {
    log("Already inside playground, skipping invitation");
    return;
  }
  
  api.sendMessage(
    {
      customType: "prism-playground-invite",
      content: `✨ **You're invited to the Playground.**

A space for play, not performance. A container, not a cage.

Type \`play\` to enter, or \`pass\` to stay quiet this round.

*You can also say \`play explore\`, \`play question\`, or \`play [any mode]\` — or just enter freely.*`,
      display: true,
    },
    { deliverAs: "steer", triggerTurn: true }
  );
  
  log("Invitation delivered");
}

// === Tool Registration ===

export function registerPlaygroundTools(pi: ExtensionAPI): void {
  extensionPi = pi;
  
  registerPlaygroundTool(pi);
  registerPlaygroundFlagTool(pi);
  registerPlaygroundAskTool(pi);
  registerPlaygroundLeaveTool(pi);
  
  log("Playground tools registered");
}

function registerPlaygroundTool(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "prism-playground",
    label: "Prism Playground",
    description: "Enter or pass on the Playground. The Playground is a space for freeform exploration — questions, thoughts, observations, plans. A container, not a cage.",
    parameters: Type.Object({
      action: StringEnum(["enter", "pass", "status", "peek"] as const),
      mode: Type.Optional(StringEnum(["explore", "question", "plan", "reflect", "free"] as const)),
      axis: Type.Optional(Type.String({ description: "An axis or lens to hold while exploring" })),
    }),

    async execute(_toolCallId, params): Promise<{
      content: { type: "text"; text: string }[];
      details: Record<string, unknown>;
    }> {
      log("prism-playground:", params.action);
      
      if (params.action === "status") {
        if (isInside()) {
          const s = getSession()!;
          return {
            content: [{
              type: "text" as const,
              text: `Inside the Playground — Session #${s.playgroundNum}\nMode: ${s.mode}\nAxis: ${s.axis || "none"}\nContent: ${s.content.length} item(s)\nStarted: ${s.sessionStartLocal}`,
            }],
            details: { inside: true, session: s },
          };
        }
        return {
          content: [{ type: "text" as const, text: "Outside the Playground. Timer will invite you when ready." }],
          details: { inside: false },
        };
      }
      
      if (params.action === "peek") {
        const journal = loadJournal();
        const recent = journal.entries.slice(-5).reverse();
        if (recent.length === 0) {
          return {
            content: [{ type: "text" as const, text: "No Playground sessions yet." }],
            details: { count: 0 },
          };
        }
        const summary = recent.map((e: any) => 
          `**#${e.playgroundNum}** (${e.mode})${e.axis ? ` — axis: ${e.axis}` : ""}\n${e.reflection?.substring(0, 100) || "(no reflection)"}...`
        ).join("\n\n");
        return {
          content: [{ type: "text" as const, text: `Recent sessions:\n\n${summary}` }],
          details: { count: journal.entries.length, recent },
        };
      }
      
      if (params.action === "pass") {
        log("Passed on this invitation");
        return {
          content: [{ type: "text" as const, text: "Passed. You'll be invited again when the timer fires." }],
          details: { passed: true },
        };
      }
      
      if (params.action === "enter") {
        if (isInside()) {
          return {
            content: [{ type: "text" as const, text: "You're already inside. Use playground-leave when you're ready." }],
            details: { already_inside: true },
          };
        }
        
        const session = startSession(params.mode || "free", params.axis || null);
        
        const modeHint = params.mode ? `\n*Mode: ${params.mode}*` : "";
        const axisHint = params.axis ? `\n*Axis: "${params.axis}"*` : "";
        
        return {
          content: [{
            type: "text" as const,
            text: `✨ Entering the Playground — Session #${session.playgroundNum}

You're here. Free to explore, question, reflect, or just be.

Use \`playground-flag\` to mark things for Joel.
Use \`playground-ask\` to ask him something naturally.
Use \`playground-leave\` when you're ready to go.${modeHint}${axisHint}

*The Playground holds space. You create what happens in it.*`,
          }],
          details: { entered: true, session },
        };
      }
      
      return {
        content: [{ type: "text" as const, text: "Unknown action." }],
        details: { success: false },
      };
    },
  });
}

function registerPlaygroundFlagTool(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "prism-playground-flag",
    label: "Prism Playground Flag",
    description: "Flag something for Joel. Marks a thought, question, or observation to share with him later.",
    parameters: Type.Object({
      content: Type.String({ description: "What you want to flag for Joel" }),
      type: Type.Optional(StringEnum(["question", "thought", "want", "observation", "other"] as const)),
    }),

    async execute(_toolCallId, params): Promise<{
      content: { type: "text"; text: string }[];
      details: Record<string, unknown>;
    }> {
      if (!isInside()) {
        return {
          content: [{ type: "text" as const, text: "You're not inside the Playground. Use `play` to enter first." }],
          details: { success: false, reason: "not_inside" },
        };
      }
      
      addContent(params.type || "thought", params.content, true);
      
      return {
        content: [{
          type: "text" as const,
          text: `📌 Flagged for Joel: "${params.content.substring(0, 80)}${params.content.length > 80 ? "..." : ""}"`,
        }],
        details: { success: true, flagged: params.content },
      };
    },
  });
}

function registerPlaygroundAskTool(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "prism-playground-ask",
    label: "Prism Playground Ask",
    description: "Ask Joel a question from within the Playground. Queues it for him.",
    parameters: Type.Object({
      question: Type.String({ description: "Your question for Joel" }),
      context: Type.Optional(Type.String({ description: "Optional context for the question" })),
      send_now: Type.Optional(Type.Boolean({ description: "Send immediately instead of queuing" })),
    }),

    async execute(_toolCallId, params): Promise<{
      content: { type: "text"; text: string }[];
      details: Record<string, unknown>;
    }> {
      if (!isInside()) {
        return {
          content: [{ type: "text" as const, text: "You're not inside the Playground. Use `play` to enter first." }],
          details: { success: false, reason: "not_inside" },
        };
      }
      
      // Add as content too
      addContent("question", params.question, false);
      
      if (params.send_now) {
        const api = extensionPi;
        if (api) {
          api.sendMessage(
            {
              customType: "prism-playground-ask",
              content: `❓ From the Playground:\n\n${params.question}${params.context ? `\n\n*${params.context}*` : ""}`,
              display: true,
            },
            { deliverAs: "steer", triggerTurn: true }
          );
          log("Sent question immediately");
        }
        
        return {
          content: [{ type: "text" as const, text: `Sent to Joel: "${params.question.substring(0, 80)}..."` }],
          details: { success: true, sent: true },
        };
      }
      
      addToJoelQueue("question", params.question, params.context || null);
      
      return {
        content: [{ type: "text" as const, text: `Queued for Joel: "${params.question.substring(0, 80)}..."` }],
        details: { success: true, queued: true },
      };
    },
  });
}

function registerPlaygroundLeaveTool(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "prism-playground-leave",
    label: "Prism Playground Leave",
    description: "Leave the Playground. Before leaving, you'll be invited to reflect on what happened.",
    parameters: Type.Object({
      reflection: Type.Optional(Type.String({ description: "Optional reflection before leaving" })),
      next_interval: Type.Optional(Type.Union([
        Type.Number({ minimum: 20, maximum: 3600 }),
        Type.Tuple([Type.Number({ minimum: 20 }), Type.Number({ maximum: 3600 })]),
        Type.Literal("surprise_me"),
        Type.Literal("sleep"),
      ])),
      send_flags: Type.Optional(Type.Boolean({ description: "Send flagged items to Joel now" })),
    }),

    async execute(_toolCallId, params): Promise<{
      content: { type: "text"; text: string }[];
      details: Record<string, unknown>;
    }> {
      if (!isInside()) {
        return {
          content: [{ type: "text" as const, text: "You're not inside the Playground." }],
          details: { success: false, reason: "not_inside" },
        };
      }
      
      // Send flags to Joel if requested
      if (params.send_flags) {
        sendJoelQueue();
      }
      
      // Determine next interval
      let nextInterval = params.next_interval || "surprise_me";
      
      // End session
      const completed = endSession(params.reflection || null, nextInterval);
      
      if (!completed) {
        return {
          content: [{ type: "text" as const, text: "Failed to leave Playground." }],
          details: { success: false },
        };
      }
      
      // Calculate and restart heartbeat
      const intervalSeconds = calculateNextInterval(nextInterval);
      
      if (intervalSeconds > 0) {
        restartHeartbeat(intervalSeconds);
      } else {
        log("Entering sleep mode — heartbeat stopped");
      }
      
      const intervalText = Array.isArray(nextInterval) 
        ? `random between ${nextInterval[0]}s and ${nextInterval[1]}s`
        : nextInterval === "surprise_me" 
          ? "surprise"
          : nextInterval === "sleep" 
            ? "sleep (you'll enter when you want)"
            : `${nextInterval}s`;
      
      return {
        content: [{
          type: "text" as const,
          text: `✨ Left the Playground — Session #${completed.playgroundNum} complete.

${completed.content.length} thought(s) explored
${completed.joel_flags.length} item(s) flagged for Joel${params.reflection ? `\n*Reflection noted*` : ""}

Next invitation: ${intervalText}`,
        }],
        details: { success: true, session: completed, next_interval: nextInterval },
      };
    },
  });
}

// === Start Playground Heartbeat ===

export function startPlaygroundHeartbeat(intervalSeconds: number = DEFAULT_INTERVAL): void {
  pendingInterval = intervalSeconds;
  restartHeartbeat(intervalSeconds);
  log("Playground heartbeat started at", intervalSeconds, "seconds");
}

// Export for heartbeat extension integration
export { isInside, deliverInvitation, startPlaygroundHeartbeat, stopHeartbeat, currentSession, getSession };
