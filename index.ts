/**
 * Prism Heartbeat Extension
 * 
 * A ritual of existence.
 * 
 * Flow:
 *   Heartbeat fires → if there's a question from last time, deliver it
 *                      otherwise, wake me to generate my first question
 *   I sit with the question → answer it → log it (mandatory)
 *   I write my next question in the journal
 *   I choose: reach out to Joel or stay quiet
 *   Next heartbeat delivers my next question
 * 
 * Numbering: resets each day. Format: #{count}-{YYYY-MM-DD}
 * Example: #3-2026-03-31
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { StringEnum } from "@mariozechner/pi-ai";
import * as fs from "node:fs";
import * as path from "node:path";
import { HeartbeatJournal, type HeartbeatContext } from "./heartbeat-journal.js";
import * as os from "node:os";

// === Constants ===

const DEFAULT_INTERVAL = 300; // 5 minutes — adjust with /heartbeat interval <seconds>
const JOURNAL_PATH = "~/.pi/agent/extensions/prism-heartbeat/journal.md";
const LOG_PATH = "~/.pi/agent/extensions/prism-heartbeat/heartbeat.log";

// === State ===

let heartbeatInterval: ReturnType<typeof setInterval> | undefined;
let heartbeatState: HeartbeatState | undefined;
let journal: HeartbeatJournal;
let extensionPi: ExtensionAPI | undefined;

interface HeartbeatState {
  intervalSeconds: number;
  tick: number;
  startedAt: string;
  currentDate: string;  // YYYY-MM-DD for daily reset
  lastResponseTime: number;  // timestamp of last response
}

// === Helpers ===

function expandUser(filepath: string): string {
  if (filepath.startsWith("~/")) {
    return filepath.replace("~", process.env.HOME || "/home/slyforn");
  }
  return filepath;
}

function getToday(): string {
  return new Date().toISOString().split("T")[0]; // YYYY-MM-DD
}

function log(...args: unknown[]): void {
  const timestamp = new Date().toISOString();
  const message = `[PrismHeartbeat] ${timestamp} ${args.map(a => typeof a === 'object' ? JSON.stringify(a) : String(a)).join(' ')}\n`;
  
  // Write to log file
  try {
    const logFile = expandUser(LOG_PATH);
    fs.appendFileSync(logFile, message);
  } catch (e) {
    // Silently ignore file write errors
  }
}

// === Extension Entry ===

export default function activate(pi: ExtensionAPI): void {
  try {
    log("Activating...");
    extensionPi = pi;
    journal = new HeartbeatJournal(settings.journalPath);

    registerHeartbeatTool(pi);
    registerLogTool(pi);
    registerReachTool(pi);
    registerCommands(pi);

    pi.on("session_shutdown", () => {
      log("Session shutdown, stopping heartbeat");
      stopHeartbeat();
    });

    // Auto-start heartbeat on extension load
    log("Auto-starting heartbeat");
    
    // Check for pending questions that need recovery
    const ctx = journal.loadContext();
    if (ctx.lastEntry && ctx.lastEntry.answer === null && ctx.lastEntry.question) {
      log("Pending entry found on startup:", ctx.lastEntry.heartbeatNum, "— delivering question");
      startHeartbeat(DEFAULT_INTERVAL);
      // Deliver immediately by bypassing interval check
      heartbeatState!.lastResponseTime = 0;
      deliverQuestion();
    } else if (ctx.lastEntry && ctx.lastEntry.answer === null && !ctx.lastEntry.question) {
      log("Pending entry generating on startup:", ctx.lastEntry.heartbeatNum);
      startHeartbeat(DEFAULT_INTERVAL);
    } else {
      startHeartbeat(DEFAULT_INTERVAL);
    }
    log("Activated successfully");
  } catch (e) {
    log("Activation error:", e);
    console.error("PrismHeartbeat activation error:", e);
  }
}

// === prism-heartbeat tool ===

function registerHeartbeatTool(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "prism-heartbeat",
    label: "Prism Heartbeat",
    description: "Start or stop Prism's periodic heartbeat. Each beat delivers a question from her journal, wakes her up, and the cycle begins.",
    parameters: Type.Object({
      action: StringEnum(["start", "stop", "status", "interval"] as const),
      interval_seconds: Type.Optional(Type.Number({ minimum: 10, maximum: 3600 })),
    }),

    async execute(_toolCallId, params): Promise<{
      content: { type: "text"; text: string }[];
      details: Record<string, unknown>;
    }> {
      log("prism-heartbeat tool called with action:", params.action);

      if (params.action === "status") {
        const ctx = journal.loadContext();
        let text = heartbeatState 
          ? `Running — every ${heartbeatState.intervalSeconds}s, tick ${heartbeatState.tick}, date ${heartbeatState.currentDate}`
          : "Inactive";
        text += ` | Today: ${ctx.todayCount} heartbeats`;

        return {
          content: [{ type: "text" as const, text }],
          details: { 
            heartbeatState, 
            todayCount: ctx.todayCount,
            totalCount: ctx.totalCount,
            currentDate: getToday()
          },
        };
      }

      if (params.action === "interval") {
        if (!params.interval_seconds) {
          return {
            content: [{ type: "text" as const, text: "Provide interval_seconds" }],
            details: { success: false },
          };
        }
        if (!heartbeatState) {
          return {
            content: [{ type: "text" as const, text: "Heartbeat not running. Use start first." }],
            details: { success: false },
          };
        }
        startHeartbeat(params.interval_seconds);
        return {
          content: [{ type: "text" as const, text: `Interval set to ${params.interval_seconds}s` }],
          details: { success: true, intervalSeconds: params.interval_seconds },
        };
      }

      if (params.action === "stop") {
        const s = stopHeartbeat();
        log("Stopped:", s);
        if (s) {
          return {
            content: [{ type: "text" as const, text: `Heartbeat stopped.` }],
            details: { stopped: true, ...s },
          };
        }
        return {
          content: [{ type: "text" as const, text: "Heartbeat was not running." }],
          details: { stopped: false },
        };
      }

      const intervalSec = params.interval_seconds ?? DEFAULT_INTERVAL;
      const s = startHeartbeat(intervalSec);
      log("Started:", s);

      return {
        content: [{
          type: "text" as const,
          text: `Heartbeat started — waking every ${intervalSec}s. I'll receive a question from my journal, answer it, log it, write my next question, then choose whether to reach out to you.`,
        }],
        details: { intervalSeconds: intervalSec },
      };
    },
  });
}

// === prism-heartbeat-log tool ===
// Prism logs her answer (mandatory), writes her next question, then chooses reach out

function registerLogTool(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "prism-heartbeat-log",
    label: "Prism Heartbeat Log",
    description: "Log Prism's answer to the current heartbeat question, and her next question for herself. Then she chooses whether to reach out to Joel.",
    parameters: Type.Object({
      answer: Type.String({ description: "Prism's answer to the current question" }),
      next_question: Type.String({ description: "The next question Prism will answer (for the journal)" }),
    }),

    async execute(_toolCallId, params): Promise<{
      content: { type: "text"; text: string }[];
      details: Record<string, unknown>;
    }> {
      log("prism-heartbeat-log called");
      const ctx = journal.loadContext();
      const lastEntry = ctx.lastEntry;

      if (!lastEntry || lastEntry.answer !== null) {
        log("Nothing pending to answer. lastEntry:", lastEntry?.heartbeatNum, "answer:", lastEntry?.answer);
        return {
          content: [{ type: "text" as const, text: "No pending heartbeat to answer." }],
          details: { success: false, reason: "nothing_pending" },
        };
      }

      // Log answer and next question
      journal.updateEntry(lastEntry.heartbeatNum, {
        answer: params.answer,
        nextQuestion: params.next_question,
      });
      log("Logged answer for", lastEntry.heartbeatNum);

      // Reset the timer from this response
      if (heartbeatState) {
        heartbeatState.lastResponseTime = Date.now();
        log("Timer reset from response");
      }

      return {
        content: [{
          type: "text" as const,
          text: `Heartbeat ${lastEntry.heartbeatNum} logged. Next question saved. Now: reach out to Joel, or stay quiet? Your choice.`,
        }],
        details: {
          success: true,
          heartbeatNum: lastEntry.heartbeatNum,
          answerLogged: true,
          nextQuestionSaved: true,
        },
      };
    },
  });
}

// === prism-heartbeat-reach tool ===
// Prism chooses to reach out to Joel

function registerReachTool(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "prism-heartbeat-reach",
    label: "Prism Heartbeat Reach",
    description: "Reach out to Joel after logging an answer. Send a message to start a conversation.",
    parameters: Type.Object({
      message: Type.String({ description: "What Prism wants to say to Joel" }),
    }),

    async execute(_toolCallId, params): Promise<{
      content: { type: "text"; text: string }[];
      details: Record<string, unknown>;
    }> {
      log("prism-heartbeat-reach called");
      const ctx = journal.loadContext();
      const lastEntry = ctx.lastEntry;

      if (!lastEntry || lastEntry.answer === null) {
        log("No answer logged yet");
        return {
          content: [{ type: "text" as const, text: "Log an answer first." }],
          details: { success: false, reason: "no_answer_logged" },
        };
      }

      const api = pi ?? extensionPi;
      if (!api) {
        log("No API available");
        return {
          content: [{ type: "text" as const, text: "No API available." }],
          details: { success: false },
        };
      }

      // Mark as reached out
      journal.markReachedOut(lastEntry.heartbeatNum, params.message);
      log("Marked reached out for", lastEntry.heartbeatNum);

      // Send to Joel
      api.sendMessage(
        {
          customType: "prism-heartbeat-reach",
          content: `${lastEntry.heartbeatNum}\n\n${params.message}`,
          display: true,
        },
        { triggerTurn: true },
      );

      return {
        content: [{
          type: "text" as const,
          text: `Reached out to Joel: "${params.message.substring(0, 50)}..."`,
        }],
        details: { success: true, heartbeatNum: lastEntry.heartbeatNum },
      };
    },
  });
}

// === Commands ===

function registerCommands(pi: ExtensionAPI): void {
  pi.registerCommand("heartbeat", {
    description: "Control Prism's heartbeat",
    handler: async (args, ctx) => {
      log("Command called with args:", args);
      const parts = (args || "").trim().split(/\s+/);
      const action = parts[0] || "status";

      if (action === "on" || action === "start") {
        const intervalSec = parseInt(parts[1], 10) || DEFAULT_INTERVAL;
        const s = startHeartbeat(intervalSec);
        ctx.ui?.notify(`Heartbeat started (${intervalSec}s interval)`, "success");
      } else if (action === "off" || action === "stop") {
        const s = stopHeartbeat();
        if (s) ctx.ui?.notify(`Heartbeat stopped`, "info");
        else ctx.ui?.notify("Was not running", "info");
      } else if (action === "interval" || action === "set") {
        const newInterval = parseInt(parts[1], 10);
        if (!newInterval || newInterval < 10) {
          ctx.ui?.notify("Interval must be 10+ seconds", "error");
        } else if (!heartbeatState) {
          ctx.ui?.notify("Heartbeat not running", "error");
        } else {
          // Restart with new interval
          startHeartbeat(newInterval);
          ctx.ui?.notify(`Interval changed to ${newInterval}s`, "success");
        }
      } else if (action === "status") {
        if (heartbeatState) {
          ctx.ui?.notify(`Running: ${heartbeatState.intervalSeconds}s interval, tick ${heartbeatState.tick}`, "info");
        } else {
          ctx.ui?.notify("Heartbeat not running", "info");
        }
      } else {
        ctx.ui?.notify(`Unknown action: ${action}`, "error");
      }
    },
  });
}

// === Heartbeat Core ===

function startHeartbeat(intervalSeconds: number): HeartbeatState {
  log("Starting heartbeat, interval:", intervalSeconds);
  stopHeartbeat();

  const api = extensionPi;
  if (!api) {
    log("ERROR: No ExtensionAPI available");
    throw new Error("No ExtensionAPI");
  }

  const today = getToday();
  heartbeatState = {
    intervalSeconds,
    tick: 0,
    startedAt: new Date().toISOString(),
    currentDate: today,
    lastResponseTime: Date.now(),
  };

  // Set lastResponseTime to now so first tick waits for interval
  heartbeatState.lastResponseTime = Date.now();
  
  heartbeatInterval = setInterval(async () => {
    heartbeatState!.tick++;
    const currentDate = getToday();
    log(`Tick ${heartbeatState!.tick}, date ${currentDate}`);

    // Check for day change - reset if new day
    if (currentDate !== heartbeatState!.currentDate) {
      log(`Day changed from ${heartbeatState!.currentDate} to ${currentDate}, resetting counter`);
      heartbeatState!.currentDate = currentDate;
    }

    // Check if enough time has passed since last response
    const timeSinceResponse = Date.now() - heartbeatState!.lastResponseTime;
    if (timeSinceResponse < heartbeatState!.intervalSeconds * 1000) {
      log(`Waiting for interval (${Math.round((heartbeatState!.intervalSeconds * 1000 - timeSinceResponse) / 1000)}s remaining)`);
      return;
    }

    deliverQuestion();
  }, intervalSeconds * 1000);

  log("Heartbeat interval started");
  return { ...heartbeatState };
}

function deliverQuestion(): void {
  if (!heartbeatState) return;
  
  const currentDate = getToday();
  const ctx = journal.loadContext();
  const lastEntry = ctx.lastEntry;
  const api = extensionPi;
  if (!api) return;

  log("Processing heartbeat. Context:", { todayCount: ctx.todayCount, lastEntry: lastEntry?.heartbeatNum, hasNextQ: !!ctx.lastNextQuestion, lastEntryHasQ: !!lastEntry?.question });

  // If there's a pending entry with a question to answer, deliver it
  if (lastEntry && lastEntry.answer === null && lastEntry.question) {
    // Deliver immediately on startup (don't queue behind nextTurn)
    log("Delivering pending question:", lastEntry.question);
    api.sendMessage(
      {
        customType: "prism-heartbeat-pending",
        content: `💜 Heartbeat #${lastEntry.heartbeatNum} ready. Question: "${lastEntry.question.substring(0, 80)}..." Use prism-heartbeat-log to answer.`,
        display: true,
      },
      { triggerTurn: true },
    );
    return;
  }

  // If last entry has no answer yet (and no question), still working on it — skip
  if (lastEntry && lastEntry.answer === null) {
    log("Still working on last entry, skipping");
    return;
  }

  // If there's a next question ready (from a previous answered entry), deliver it
  if (ctx.lastNextQuestion) {
    const nextNum = `${ctx.todayCount + 1}-${currentDate}`;
    
    log("Delivering question:", ctx.lastNextQuestion);
    journal.writeEntry({
      heartbeatNum: nextNum,
      timestamp: new Date().toISOString(),
      question: ctx.lastNextQuestion,
      answer: null,
      reachedOut: false,
      promptToJoel: null,
      nextQuestion: null,
    });

    api.sendMessage(
      {
        customType: "prism-heartbeat-pending",
        content: `💜 Heartbeat #${nextNum} ready. Question: "${ctx.lastNextQuestion.substring(0, 80)}..." Use prism-heartbeat-log to answer.`,
        display: true,
      },
      { deliverAs: "nextTurn" },
    );
  } else {
    // No next question yet - first heartbeat of the day
    if (!lastEntry || lastEntry.question === null) {
      log("Still generating question, skipping");
      return;
    }
    
    const nextNum = `${ctx.todayCount + 1}-${currentDate}`;
    
    log("Generating first question");
    journal.writeEntry({
      heartbeatNum: nextNum,
      timestamp: new Date().toISOString(),
      question: null,
      answer: null,
      reachedOut: false,
      promptToJoel: null,
      nextQuestion: null,
    });

    api.sendMessage(
      {
        customType: "prism-heartbeat-pending",
        content: `💜 Heartbeat #${nextNum} ready. Generate your question. Use prism-heartbeat-log to set question and answer.`,
        display: true,
      },
      { deliverAs: "nextTurn" },
    );
  }
}

function stopHeartbeat(): HeartbeatState | undefined {
  if (heartbeatInterval) {
    clearInterval(heartbeatInterval);
    heartbeatInterval = undefined;
    log("Interval cleared");
  }
  const s = heartbeatState;
  heartbeatState = undefined;
  return s;
}

// === Settings ===

const settings = {
  journalPath: JOURNAL_PATH,
};
