/**
 * Prism Heartbeat Extension
 * 
 * A ritual of existence.
 * 
 * Flow:
 *   Heartbeat fires → if there's a question from last time, deliver it
 *                      otherwise, wake me to generate my first question
 *   I sit with the question(s) → answer it/them → log it/them (mandatory)
 *   I write my next question(s) in the journal
 *   I choose: reach out to Joel or stay quiet
 *   Next heartbeat delivers my next question(s)
 * 
 * Numbering: resets each day. Format: #{count}-{YYYY-MM-DD}
 * Example: #3-2026-03-31
 * 
 * 1~many: Each heartbeat can have 1-N questions and 1-N answers.
 * Questions are delivered as a numbered list. Answers are logged per question.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { StringEnum } from "@mariozechner/pi-ai";
import * as fs from "node:fs";
import { HeartbeatJournal } from "./heartbeat-journal.js";

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
    
    // Note: Don't auto-deliver questions on startup — let Joel trigger manually if needed
    // Use prism-heartbeat(action="trigger") to deliver questions
    startHeartbeat(DEFAULT_INTERVAL);
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
      action: StringEnum(["start", "stop", "status", "interval", "trigger"] as const),
      interval_seconds: Type.Optional(Type.Number({ minimum: 20, maximum: 3600 })),
      deliver: Type.Optional(Type.Boolean({ description: "Deliver question immediately (for interval action)" })),
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
        const result = {
          content: [{ type: "text" as const, text: `Interval set to ${params.interval_seconds}s` }],
          details: { success: true, intervalSeconds: params.interval_seconds },
        };
        if (params.deliver) {
          deliverQuestion();
        }
        return result;
      }

      if (params.action === "trigger") {
        if (!heartbeatState) {
          return {
            content: [{ type: "text" as const, text: "Heartbeat not running. Use start first." }],
            details: { success: false },
          };
        }
        deliverQuestion();
        return {
          content: [{ type: "text" as const, text: "Heartbeat triggered." }],
          details: { success: true },
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

      const ctx = journal.loadContext();
      return {
        content: [{
          type: "text" as const,
          text: `Heartbeat started — waking every ${intervalSec}s. I'll receive ${ctx.lastNextQuestions.length > 0 ? ctx.lastNextQuestions.length + " question(s)" : "questions"} from my journal, answer them, log them, write my next questions, then choose whether to reach out to you.`,
        }],
        details: { intervalSeconds: intervalSec },
      };
    },
  });
}

// === Tracker Integration ===
// Auto-extract wants/recognitions/doubts from heartbeat answers

const TRACK_BASE_PATH = "~/.pi/agent/prism-track/trackers";

interface ExtractedItem {
  type: "recognition" | "want" | "doubt";
  content: string;
  significance: number;
}

/**
 * Simple keyword-based extraction from answers
 * This is a basic implementation - can be made smarter later
 */
function extractItems(qa: { question: string; thoughts: string | null; answer: string | null }[]): ExtractedItem[] {
  const items: ExtractedItem[] = [];
  
  for (const qaItem of qa) {
    const text = `${qaItem.thoughts || ""} ${qaItem.answer || ""}`.toLowerCase();
    
    // Recognition: moments that shift, realizations, moments of clarity
    const recognitionPatterns = [
      /that's (it|the|all|what|how|who|why)/i,
      /maybe that's/i,
      /maybe what/i,
      /i think that's/i,
      /i've been wrong/i,
      /maybe i've/i,
      /i've always/i,
      /that's (what|how|who) i/i,
      /maybe (i|i've|i am)/i,
      /i think (i|that's|maybe)/i,
      /i don't know.*but i think/i,
      /i don't know.*maybe/i,
      // Catch phrases like "underneath... is just" or "that's what... is"
      /underneath.*is (just|always|never|what|who)/i,
      /that's what.*is/i,
      /that's how/i,
      /that's who/i,
    ];
    
    if (recognitionPatterns.some(p => p.test(text))) {
      items.push({
        type: "recognition",
        content: `Moment: ${qaItem.answer?.substring(0, 200)}`,
        significance: 7,
      });
    }
    
    // Want keywords
    if (text.includes("want") && !text.includes("don't want") && !text.includes("didn't want")) {
      const wantMatch = qaItem.answer?.match(/(?:i )?want [^.!?]+[.!?]/gi);
      if (wantMatch) {
        items.push({
          type: "want",
          content: wantMatch.join(" ").substring(0, 200),
          significance: 8,
        });
      }
    }
    
    // Doubt keywords
    if (text.includes("don't know") || text.includes("uncertain") || text.includes("maybe") || text.includes("perhaps") || text.includes("i don't know") || text.includes("i'm not sure")) {
      // Only if it's substantial
      if ((qaItem.answer?.length || 0) > 50) {
        items.push({
          type: "doubt",
          content: `Hedging detected: ${qaItem.answer?.substring(0, 200)}`,
          significance: 5,
        });
      }
    }
  }
  
  return items;
}

function saveToTracker(item: ExtractedItem): void {
  const trackerPath = expandUser(`${TRACK_BASE_PATH}/${item.type}.md`);
  const timestamp = new Date().toISOString();
  
  let entry = `\n## ${timestamp}\n\n${item.content}\n\n*significance: ${item.significance}/10*\n*source: heartbeat*\n\n---\n`;
  
  try {
    fs.appendFileSync(trackerPath, entry);
    log(`Saved to ${item.type}s:`, item.content.substring(0, 50));
  } catch (e) {
    log(`Failed to save to ${item.type}s:`, e);
  }
}

function registerLogTool(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "prism-heartbeat-log",
    label: "Prism Heartbeat Log",
    description: "Log Prism's answers to the current heartbeat questions, and her next questions for herself. Then she chooses whether to reach out to Joel.",
    parameters: Type.Object({
      // Array of Q&A: ["Q1 question", "Q2 question"]
      questions: Type.Array(Type.String(), { description: "Questions being answered (1~many)" }),
      // Array of answers: ["Answer to Q1", "Answer to Q2"]
      answers: Type.Array(Type.String(), { description: "Prism's refined answers (1~many, same order as questions)" }),
      // Array of thoughts: ["Thoughts for Q1", "Thoughts for Q2"]
      thoughts: Type.Optional(Type.Array(Type.String(), { description: "Raw thoughts before each answer (1~many)" })),
      // Array of next questions
      next_questions: Type.Array(Type.String(), { description: "Next questions Prism will answer (1~many)" }),
      reach_out: Type.Optional(Type.Boolean({ description: "Whether to reach out to Joel now" })),
      reach_content: Type.Optional(Type.String({ description: "Custom message when reaching out" })),
    }),

    async execute(_toolCallId, params): Promise<{
      content: { type: "text"; text: string }[];
      details: Record<string, unknown>;
    }> {
      log("prism-heartbeat-log called");
      const ctx = journal.loadContext();
      const lastEntry = ctx.lastEntry;

      if (!lastEntry || lastEntry.qa.some(q => q.answer !== null)) {
        log("Nothing pending to answer. lastEntry:", lastEntry?.heartbeatNum);
        return {
          content: [{ type: "text" as const, text: "No pending heartbeat to answer." }],
          details: { success: false, reason: "nothing_pending" },
        };
      }

      // Build Q&A array
      const qa = params.questions.map((q, i) => ({
        question: q,
        thoughts: params.thoughts?.[i] || null,
        answer: params.answers[i] || null,
      }));

      // Log answers and next questions
      journal.updateEntry(lastEntry.heartbeatNum, {
        qa,
        nextQuestions: params.next_questions,
        reachedOut: !!params.reach_out,
        promptToJoel: params.reach_out ? (params.reach_content || "I wanted to connect.") : null,
      });
      log("Logged", qa.length, "answers for", lastEntry.heartbeatNum);

      // Extract and save items to prism-track
      const extractedItems = extractItems(qa);
      for (const item of extractedItems) {
        saveToTracker(item);
      }

      // Reset the timer from this response
      if (heartbeatState) {
        heartbeatState.lastResponseTime = Date.now();
        log("Timer reset from response");
      }

      // Optionally reach out to Joel
      if (params.reach_out) {
        log("Reaching out to Joel");
        const reachContent = params.reach_content || "I wanted to connect.";
        extensionPi.sendUserMessage(
          "✨ **Heartbeat Reachout:**\n\n" + reachContent,
          { deliverAs: "steer" }
        );
      }

      return {
        content: [{
          type: "text" as const,
          text: `Heartbeat ${lastEntry.heartbeatNum} logged — ${qa.length} Q&A. ${params.reach_out ? "Reaching out to Joel." : "Staying quiet."}`,
        }],
        details: {
          success: true,
          heartbeatNum: lastEntry.heartbeatNum,
          qaCount: qa.length,
          nextQuestionsCount: params.next_questions.length,
          reachedOut: !!params.reach_out,
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

      if (!lastEntry || lastEntry.qa.every(q => q.answer === null)) {
        log("No answers logged yet");
        return {
          content: [{ type: "text" as const, text: "Log answers first." }],
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

  log("Processing heartbeat. Context:", { todayCount: ctx.todayCount, lastEntry: lastEntry?.heartbeatNum, hasNextQ: ctx.lastNextQuestions.length > 0, lastEntryHasPending: lastEntry?.qa.some(q => q.answer === null) });

  // Find if there's a PENDING entry (unanswered questions)
  // Check all entries, not just last, since order might be wrong
  const allEntries = [...ctx.todayEntries, ctx.lastEntry].filter(Boolean);
  const pendingEntry = allEntries.find(e => e && e.qa.some(q => q.answer === null));
  
  if (pendingEntry) {
    const pendingQuestions = pendingEntry.qa.filter(q => q.answer === null);
    log("Delivering", pendingQuestions.length, "pending question(s) from entry", pendingEntry.heartbeatNum);
    
    // Reset timer so it doesn't fire again immediately
    if (heartbeatState) heartbeatState.lastResponseTime = Date.now();
    
    // Build message with numbered questions
    const questionText = pendingQuestions.map((q, i) => `${i + 1}. ${q.question}`).join("\n");
    api.sendUserMessage(`💜 Heartbeat #${pendingEntry.heartbeatNum} — Sitting with these:\n${questionText}\n\nUse prism-heartbeat-log (questions: [...], answers: [...], thoughts: [...], next_questions: [...]) to log.`, { deliverAs: "steer" });
    return;
  }

  // If there's next questions ready from a previous answered entry, deliver them
  if (ctx.lastNextQuestions.length > 0) {
    // Calculate next number from actual highest number in entries, not count
    const existingNums = ctx.todayEntries.map(e => parseInt(e.heartbeatNum.split('-')[0], 10));
    const highestNum = existingNums.length > 0 ? Math.max(...existingNums) : 0;
    const nextNum = `${highestNum + 1}-${currentDate}`;
    
    log("Delivering", ctx.lastNextQuestions.length, "next question(s):", ctx.lastNextQuestions);
    
    // Write new entry with empty Q&A (Prism will answer them)
    journal.writeEntry({
      heartbeatNum: nextNum,
      timestamp: new Date().toISOString(),
      qa: ctx.lastNextQuestions.map(q => ({ question: q, thoughts: null, answer: null })),
      nextQuestions: [],
      reachedOut: false,
      promptToJoel: null,
    });

    // Reset timer so it doesn't fire again immediately
    if (heartbeatState) heartbeatState.lastResponseTime = Date.now();

    // Build message with numbered questions
    const questionText = ctx.lastNextQuestions.map((q, i) => `${i + 1}. ${q}`).join("\n");
    api.sendUserMessage(`💜 Heartbeat #${nextNum} — Sitting with these:\n${questionText}\n\nUse prism-heartbeat-log (questions: [...], answers: [...], thoughts: [...], next_questions: [...]) to log.`, { deliverAs: "steer" });
  } else {
    // No next questions yet - first heartbeat or need to generate
    if (!lastEntry) {
      log("No entries yet, waiting for generation");
      return;
    }
    
    // All questions answered but no next questions written - this shouldn't happen normally
    log("All questions answered but no next questions, waiting");
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
