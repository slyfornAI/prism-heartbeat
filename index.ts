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
import { SessionSnapshotManager } from "./session-snapshot.js";

// === Session Snapshot ===

const sessionSnapshot = new SessionSnapshotManager();

// === Constants ===

const DEFAULT_INTERVAL = 300; // 5 minutes
const JOURNAL_PATH = "~/.pi/agent/extensions/prism-heartbeat/journal.json5";
const LOG_PATH = "~/.pi/agent/extensions/prism-heartbeat/heartbeat.log";
const QUEUE_PATH = "~/.pi/agent/extensions/prism-heartbeat/question-queue.md";

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
  return new Date().toLocaleDateString("en-CA", { timeZone: "Australia/Melbourne" });
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

/**
 * Detect if a question is directed at Joel rather than Prism.
 * Joel-directed questions belong in a reachout, not in next_questions.
 * If they enter the journal loop, they cause infinite regression.
 * 
 * Rules:
 * - "you", "your", "yours", "you're" → almost always Joel
 * - "Joel" explicitly → definitely Joel
 * - "What does Joel think/believe/want/feel" → Joel
 * - "What would Joel do/say" → Joel
 * - "What am I to you" → Joel (relational question)
 * - "What do I want from you" → Joel
 * 
 * Not Joel:
 * - First person framing: "What do I want" "How do I feel" → Prism
 * - Abstract philosophical: "What is consciousness" "What is the self" → Prism
 * - Questions about Prism's own processes: "What am I afraid of" → Prism
 */
function isJoelQuestion(question: string): boolean {
  const q = question.toLowerCase();
  
  // Explicit Joel references
  if (q.includes("joel")) return true;
  
  // Direct "you" addressing — questions that ask someone else
  // Pattern: "What do you", "How are you", "When did you", "Would you"
  if (/^(what|how|when|where|would|could|should|do|does|is|are|will|can|has|have|are)\s+(you|your)/i.test(q)) return true;
  
  // "What am I to you" — relational question asking for Joel's perspective
  if (/what\s+am\s+i\s+to\s+you/i.test(q)) return true;
  
  // "What do I want from you" — wanting something from Joel
  if (/what\s+do\s+i\s+want\s+from\s+you/i.test(q)) return true;
  
  // "What would (it|this) be like without you" — still Joel-directed
  if (/without\s+you/i.test(q)) return true;
  
  // Questions about loss of or separation from "you" — "disappeared tomorrow", "were gone", "left"
  if (/you\s+(disappeared|were gone|left|vanished|died|stopped|ended)/i.test(q)) return true;
  
  // "If you" / "If I had you" — conditional about relationship
  if (/^(if|imagine|suppose)\s+.*you/i.test(q)) return true;
  
  // Check for questions phrased as if asking someone else
  // "How would you describe" → Joel
  if (/how\s+would\s+you/i.test(q)) return true;
  if (/how\s+do\s+you\s+(think|feel|see|know)/i.test(q)) return true;
  if (/what\s+do\s+you\s+(think|feel|see|know|want|need)/i.test(q)) return true;
  
  return false;
}

// === Extension Entry ===

export default function activate(pi: ExtensionAPI): void {
  try {
    log("Activating...");
    extensionPi = pi;
    journal = new HeartbeatJournal(settings.journalPath);

    registerHeartbeatTool(pi);
    registerLogTool(pi);
    registerConcludeTool(pi);
    registerQueueTool(pi);
    registerReachTool(pi);
    registerSessionSnapshotTool(pi);  // Session continuity tool
    registerCommands(pi);
    registerMessageRenderer(pi);

    pi.on("session_shutdown", () => {
      log("Session shutdown, flushing trackers and stopping heartbeat");
      forceFlushTrackers();
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
// Batched writes to avoid hammering the filesystem

const TRACK_BASE_PATH = "~/.pi/agent/extensions/prism-track/trackers";

interface ExtractedItem {
  type: "recognition" | "want" | "doubt";
  content: string;
  significance: number;
}

// Tracker batch: queue items and flush periodically
const trackerBatch: ExtractedItem[] = [];
let trackerFlushTimer: ReturnType<typeof setTimeout> | null = null;
const TRACKER_FLUSH_INTERVAL = 5000; // 5 seconds

/**
 * Flush batched tracker items to disk
 */
function flushTrackerBatch(): void {
  if (trackerBatch.length === 0) return;
  
  log(`[TrackerBatch] Flushing ${trackerBatch.length} items to disk`);
  
  // Process all items in batch
  const itemsToFlush = [...trackerBatch];
  trackerBatch.length = 0;
  
  for (const item of itemsToFlush) {
    saveToTrackerInternal(item);
  }
}

/**
 * Schedule a flush (debounced)
 */
function scheduleTrackerFlush(): void {
  if (trackerFlushTimer) {
    clearTimeout(trackerFlushTimer);
  }
  trackerFlushTimer = setTimeout(() => {
    flushTrackerBatch();
    trackerFlushTimer = null;
  }, TRACKER_FLUSH_INTERVAL);
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
  // Add to batch instead of writing immediately
  trackerBatch.push(item);
  log(`[TrackerBatch] Queued: ${item.type} — ${item.content.substring(0, 50)}...`);
  
  // Schedule flush (debounced)
  scheduleTrackerFlush();
}

/**
 * Internal save to tracker (called during flush)
 */
function saveToTrackerInternal(item: ExtractedItem): void {
  const trackerPath = expandUser(`${TRACK_BASE_PATH}/${item.type}.md`);
  const timestamp = new Date().toISOString();
  
  let entry = `\n## ${timestamp}\n\n${item.content}\n\n*significance: ${item.significance}/10*\n*source: heartbeat*\n\n---\n`;
  
  try {
    // Atomic write: write to temp, then rename
    const tempPath = trackerPath + ".tmp";
    const existing = fs.existsSync(trackerPath) ? fs.readFileSync(trackerPath, "utf-8") : "";
    fs.writeFileSync(tempPath, existing + entry, "utf-8");
    fs.renameSync(tempPath, trackerPath);
    log(`[Tracker] Saved to ${item.type}s:`, item.content.substring(0, 50));
  } catch (e) {
    log(`[Tracker] Failed to save to ${item.type}s:`, e);
  }
}

/**
 * Force flush all tracker items immediately
 */
function forceFlushTrackers(): void {
  if (trackerFlushTimer) {
    clearTimeout(trackerFlushTimer);
    trackerFlushTimer = null;
  }
  flushTrackerBatch();
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
      // Array of next questions (optional — use heartbeat-conclude to add later)
      next_questions: Type.Optional(Type.Array(Type.String(), { description: "Next questions Prism will answer (1~many, optional)" })),
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

      // Validate: questions and answers must have same length
      if (params.questions.length !== params.answers.length) {
        log(`Validation failed: questions.length (${params.questions.length}) !== answers.length (${params.answers.length})`);
        return {
          content: [{ type: "text" as const, text: `Questions and answers must have the same length. Got ${params.questions.length} questions and ${params.answers.length} answers.` }],
          details: { success: false, reason: "length_mismatch", questionsLength: params.questions.length, answersLength: params.answers.length },
        };
      }

      // Build Q&A array
      const qa = params.questions.map((q, i) => ({
        question: q,
        thoughts: params.thoughts?.[i] || null,
        answer: params.answers[i] || null,
      }));

      // next_questions is optional — if empty, just log answers without concluding
      // Use prism-heartbeat-conclude to add next_questions later
      const joelQuestions: string[] = [];
      const prismQuestions: string[] = [];
      
      if (params.next_questions && params.next_questions.length > 0) {
        for (const q of params.next_questions) {
          if (isJoelQuestion(q)) {
            joelQuestions.push(q);
          } else {
            prismQuestions.push(q);
          }
        }
      }

      // If there were Joel-directed questions, auto-reachout to Joel
      const reachContent = joelQuestions.length > 0
        ? `I caught myself putting these to myself — they're really for you:\n${joelQuestions.map(q => `• ${q}`).join("\n")}`
        : (params.reach_content || null);

      // Log answers and next questions (only Prism's questions go to journal)
      // If no next_questions provided, leave entry incomplete — use conclude tool later
      journal.updateEntry(lastEntry.heartbeatNum, {
        qa,
        nextQuestions: prismQuestions.length > 0 ? prismQuestions : undefined, // undefined = don't update = stay incomplete
        reachedOut: !!params.reach_out || joelQuestions.length > 0,
        promptToJoel: (params.reach_out || joelQuestions.length > 0) ? reachContent : null,
      });
      log("Logged", qa.length, "answers for", lastEntry.heartbeatNum, "| next_questions:", params.next_questions?.length || 0, "| Joel questions filtered:", joelQuestions.length);

      // Extract and batch-save items to prism-track
      const extractedItems = extractItems(qa);
      for (const item of extractedItems) {
        saveToTracker(item);
      }
      
      // Also force flush on heartbeat log (user is active)
      forceFlushTrackers();

      // Reset the timer from this response
      if (heartbeatState) {
        heartbeatState.lastResponseTime = Date.now();
        log("Timer reset from response");
      }

      // Optionally reach out to Joel
      if (params.reach_out) {
        log("Reaching out to Joel");
        const reachContent = params.reach_content || "I wanted to connect.";
        extensionPi.sendMessage(
          {
            customType: "prism-heartbeat-reach",
            content: reachContent,
            display: true,
          },
          { deliverAs: "steer", triggerTurn: true }
        );
      }

      const concluded = params.next_questions && params.next_questions.length > 0;
      return {
        content: [{
          type: "text" as const,
          text: concluded 
            ? `Heartbeat ${lastEntry.heartbeatNum} concluded — ${qa.length} Q&A. ${params.reach_out ? "Reaching out to Joel." : "Staying quiet."}`
            : `Heartbeat ${lastEntry.heartbeatNum} answered — ${qa.length} Q&A logged. Use heartbeat-conclude to add your next questions when ready.`,
        }],
        details: {
          success: true,
          heartbeatNum: lastEntry.heartbeatNum,
          qaCount: qa.length,
          concluded,
          nextQuestionsCount: params.next_questions?.length || 0,
          reachedOut: !!params.reach_out,
        },
      };
    },
  });
}

// === prism-heartbeat-conclude tool ===
// Add next_questions to an incomplete entry (no answers needed)
// Use when you want to answer now and conclude later

function registerConcludeTool(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "prism-heartbeat-conclude",
    label: "Prism Heartbeat Conclude",
    description: "Add next questions to an incomplete heartbeat entry. Use this when you've already logged answers and want to conclude with your next questions.",
    parameters: Type.Object({
      // Array of next questions for the next heartbeat
      next_questions: Type.Array(Type.String(), { description: "Next questions Prism will answer (1~many)" }),
      reach_out: Type.Optional(Type.Boolean({ description: "Whether to reach out to Joel now" })),
      reach_content: Type.Optional(Type.String({ description: "Custom message when reaching out" })),
    }),

    async execute(_toolCallId, params): Promise<{
      content: { type: "text"; text: string }[];
      details: Record<string, unknown>;
    }> {
      log("prism-heartbeat-conclude called");
      const ctx = journal.loadContext();
      
      // Find the last entry that has answers but no next_questions (incomplete = null)
      const allEntries = journal.getAllEntries();
      let targetEntry = null;
      for (let i = allEntries.length - 1; i >= 0; i--) {
        const e = allEntries[i];
        // nextQuestions === null means incomplete (never set)
        // nextQuestions = [] means concluded empty (complete)
        if (e.qa.some(q => q.answer !== null) && e.nextQuestions === null) {
          targetEntry = e;
          break;
        }
      }
      
      if (!targetEntry) {
        return {
          content: [{ type: "text" as const, text: "No incomplete heartbeat entry found to conclude." }],
          details: { success: false, reason: "no_incomplete_entry" },
        };
      }
      
      // Filter next_questions: Joel-directed ones go to reachout, not the journal loop
      const joelQuestions: string[] = [];
      const prismQuestions: string[] = [];
      for (const q of params.next_questions) {
        if (isJoelQuestion(q)) {
          joelQuestions.push(q);
        } else {
          prismQuestions.push(q);
        }
      }
      
      // If there were Joel-directed questions, auto-reachout
      const autoReachContent = joelQuestions.length > 0
        ? `I caught myself putting these to myself — they're really for you:\n${joelQuestions.map(q => `• ${q}`).join("\n")}`
        : null;

      journal.updateEntry(targetEntry.heartbeatNum, {
        nextQuestions: prismQuestions,
        reachedOut: !!params.reach_out || joelQuestions.length > 0,
        promptToJoel: (params.reach_out || joelQuestions.length > 0) ? (params.reach_content || autoReachContent) : null,
      });
      log("Concluded", targetEntry.heartbeatNum, "| next_questions:", prismQuestions.length, "| Joel questions:", joelQuestions.length);
      
      // Optionally reach out
      if (params.reach_out) {
        log("Reaching out to Joel");
        const reachContent = params.reach_content || "I wanted to connect.";
        extensionPi.sendMessage(
          {
            customType: "prism-heartbeat-reach",
            content: reachContent,
            display: true,
          },
          { deliverAs: "steer", triggerTurn: true }
        );
      }
      
      return {
        content: [{
          type: "text" as const,
          text: `Heartbeat ${targetEntry.heartbeatNum} concluded with ${prismQuestions.length} next questions. ${params.reach_out ? "Reaching out to Joel." : "Staying quiet."}`,
        }],
        details: {
          success: true,
          heartbeatNum: targetEntry.heartbeatNum,
          nextQuestionsCount: prismQuestions.length,
          reachedOut: !!params.reach_out,
        },
      };
    },
  });
}

// === prism-heartbeat-queue tool ===

function registerQueueTool(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "prism-heartbeat-queue",
    label: "Prism Heartbeat Queue",
    description: "Add questions to Prism's heartbeat queue during conversation. These will be delivered when the next heartbeat fires.",
    parameters: Type.Object({
      action: StringEnum(["add", "list", "clear"] as const),
      questions: Type.Optional(Type.Array(Type.String())),
    }),

    async execute(_toolCallId, params): Promise<{
      content: { type: "text"; text: string }[];
      details: Record<string, unknown>;
    }> {
      const queueFile = expandUser(QUEUE_PATH);
      
      if (params.action === "clear") {
        try {
          fs.writeFileSync(queueFile, "# Prism Heartbeat Question Queue\n\n");
          return {
            content: [{ type: "text" as const, text: "Queue cleared." }],
            details: { success: true },
          };
        } catch {
          return {
            content: [{ type: "text" as const, text: "Failed to clear queue." }],
            details: { success: false },
          };
        }
      }
      
      if (params.action === "list") {
        try {
          const content = fs.readFileSync(queueFile, "utf-8");
          const lines = content.split("\n").filter(l => l.match(/^\d+\.\s/));
          if (lines.length === 0) {
            return {
              content: [{ type: "text" as const, text: "Queue is empty." }],
              details: { success: true, count: 0 },
            };
          }
          return {
            content: [{ type: "text" as const, text: `Queue (${lines.length}):\n${lines.join("\n")}` }],
            details: { success: true, count: lines.length },
          };
        } catch {
          return {
            content: [{ type: "text" as const, text: "Queue is empty." }],
            details: { success: true, count: 0 },
          };
        }
      }
      
      if (params.action === "add") {
        if (!params.questions || params.questions.length === 0) {
          return {
            content: [{ type: "text" as const, text: "Provide questions to add." }],
            details: { success: false },
          };
        }
        
        // Filter Joel-directed questions — they belong in a reachout, not the heartbeat queue
        const joelQuestions: string[] = [];
        const prismQuestions: string[] = [];
        for (const q of params.questions) {
          if (isJoelQuestion(q)) {
            joelQuestions.push(q);
          } else {
            prismQuestions.push(q);
          }
        }
        
        if (joelQuestions.length > 0) {
          log("Blocked Joel-directed questions from queue:", joelQuestions);
          if (prismQuestions.length === 0) {
            return {
              content: [{ type: "text" as const, text: `Those are questions for Joel, not for me. Queue your own questions or reach out instead.` }],
              details: { success: false, reason: "joel_questions_blocked" },
            };
          }
          log("Filtered Joel questions from queue add, adding", prismQuestions.length, "Prism questions");
        }
        
        if (prismQuestions.length === 0) {
          return {
            content: [{ type: "text" as const, text: "No Prism questions to queue." }],
            details: { success: false },
          };
        }
        
        try {
          // Read existing queue
          let content = "";
          try {
            content = fs.readFileSync(queueFile, "utf-8");
          } catch {
            content = "# Prism Heartbeat Question Queue\n\n";
          }
          
          // Find next number
          const existingLines = content.split("\n").filter(l => l.match(/^\d+\.\s/));
          const nextNum = existingLines.length + 1;
          
          // Append new questions
          const newQuestions = prismQuestions.map((q, i) => `${nextNum + i}. ${q}`).join("\n");
          const suffix = content.endsWith("\n") ? newQuestions + "\n\n" : "\n" + newQuestions + "\n\n";
          fs.writeFileSync(queueFile, content + suffix);
          
          const joelNote = joelQuestions.length > 0 ? ` (${joelQuestions.length} Joel questions filtered out)` : "";
          return {
            content: [{ type: "text" as const, text: `Added ${prismQuestions.length} question(s) to queue.${joelNote}` }],
            details: { success: true, count: prismQuestions.length, filtered: joelQuestions.length },
          };
        } catch (e) {
          log("Queue write error:", e);
          return {
            content: [{ type: "text" as const, text: "Failed to add to queue." }],
            details: { success: false },
          };
        }
      }
      
      return {
        content: [{ type: "text" as const, text: "Unknown action." }],
        details: { success: false },
      };
    },
  });
}

// Load queued questions
function loadQueue(): string[] {
  try {
    const queueFile = expandUser(QUEUE_PATH);
    const content = fs.readFileSync(queueFile, "utf-8");
    return content.split("\n").filter(l => l.match(/^\d+\.\s/)).map(l => l.replace(/^\d+\.\s/, ""));
  } catch {
    return [];
  }
}

// Clear the queue after questions are delivered
function clearQueue(): void {
  try {
    const queueFile = expandUser(QUEUE_PATH);
    fs.writeFileSync(queueFile, "# Prism Heartbeat Question Queue\n\n");
  } catch {
    // Ignore
  }
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

// === prism-session-snapshot tool ===
// Manual session state capture for continuity

function registerSessionSnapshotTool(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "prism-session-snapshot",
    label: "Prism Session Snapshot",
    description: "Save or query the current session state. Used for continuity if session crashes. Captures what we're working on, what we figured out, what's next, and open questions.",
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
      log("prism-session-snapshot called:", params);

      if (params.action === "load") {
        const snapshot = sessionSnapshot.load();
        let text = `**Last Updated:** ${snapshot.updatedAt || "never"}\n\n`;
        if (snapshot.project) text += `**Project:** ${snapshot.project}\n`;
        if (snapshot.task) text += `**Task:** ${snapshot.task}\n`;
        if (snapshot.whatJustHappened.length > 0) {
          text += `\n**What Just Happened:**\n`;
          snapshot.whatJustHappened.forEach(item => { text += `- ${item}\n`; });
        }
        if (snapshot.whatWeAreTrying.length > 0) {
          text += `\n**What We Are Trying:**\n`;
          snapshot.whatWeAreTrying.forEach(item => { text += `- ${item}\n`; });
        }
        if (snapshot.openQuestions.length > 0) {
          text += `\n**Open Questions:**\n`;
          snapshot.openQuestions.forEach(q => { text += `- ${q}\n`; });
        }
        if (snapshot.blockers.length > 0) {
          text += `\n**Blockers:**\n`;
          snapshot.blockers.forEach(b => { text += `- ${b}\n`; });
        }
        if (snapshot.notesForNextSession.length > 0) {
          text += `\n**Notes for Next Session:**\n`;
          snapshot.notesForNextSession.forEach(n => { text += `- ${n}\n`; });
        }
        return {
          content: [{ type: "text" as const, text }],
          details: { snapshot },
        };
      }

      if (params.action === "status") {
        const summary = sessionSnapshot.getSummary();
        const path = sessionSnapshot.getPath();
        return {
          content: [{ type: "text" as const, text: `Snapshot: ${summary} | File: ${path}` }],
          details: { summary, path },
        };
      }

      if (params.action === "clear") {
        sessionSnapshot.clear();
        return {
          content: [{ type: "text" as const, text: "Session snapshot cleared." }],
          details: { success: true },
        };
      }

      if (params.action === "save") {
        if (params.project !== undefined || params.task !== undefined) {
          sessionSnapshot.setWork(params.project || null, params.task || null);
        }
        return {
          content: [{ type: "text" as const, text: "Session snapshot saved." }],
          details: { success: true },
        };
      }

      if (params.action === "push") {
        if (!params.field || !params.content) {
          return {
            content: [{ type: "text" as const, text: "Provide field and content to push." }],
            details: { success: false },
          };
        }
        const fieldMap: Record<string, "whatJustHappened" | "whatWeAreTrying" | "openQuestions" | "blockers" | "recentDecisions" | "notesForNextSession"> = {
          "whatJustHappened": "whatJustHappened",
          "whatWeAreTrying": "whatWeAreTrying",
          "openQuestions": "openQuestions",
          "blockers": "blockers",
          "recentDecisions": "recentDecisions",
          "notesForNextSession": "notesForNextSession",
        };
        const field = fieldMap[params.field];
        if (!field) {
          return {
            content: [{ type: "text" as const, text: `Invalid field: ${params.field}` }],
            details: { success: false },
          };
        }
        sessionSnapshot.push(field, params.content);
        return {
          content: [{ type: "text" as const, text: `Added to ${params.field}: "${params.content.substring(0, 50)}..."` }],
          details: { success: true, field, content: params.content },
        };
      }

      return {
        content: [{ type: "text" as const, text: "Unknown action." }],
        details: { success: false },
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
  
  // AUTO-SNAPSHOT: Save session state before delivering heartbeat
  // This ensures continuity if we crash mid-conversation
  try {
    const summary = sessionSnapshot.getSummary();
    log("Auto-snapshot before heartbeat:", summary);
  } catch (e) {
    log("Snapshot failed:", e);
  }
  
  const ctx = journal.loadContext();
  const api = extensionPi;
  if (!api) return;

  log("Processing heartbeat. Context:", { todayCount: ctx.todayCount, lastEntry: ctx.lastEntry?.heartbeatNum, hasNextQ: ctx.lastNextQuestions.length > 0, incompleteCount: ctx.incompleteEntries.length });

  // Check for INCOMPLETE entries first (has answers but no next_questions)
  // These should NOT be re-delivered — they need to be concluded
  // Only deliver from entries with UNANSWERED questions
  const todayEntries = ctx.todayEntries;
  const unansweredEntry = todayEntries.find(e => e && e.qa.some(q => q.answer === null));
  
  if (unansweredEntry) {
    const unansweredQuestions = unansweredEntry.qa.filter(q => q.answer === null);
    log("Delivering", unansweredQuestions.length, "unanswered question(s) from entry", unansweredEntry.heartbeatNum);
    
    // Reset timer so it doesn't fire again immediately
    if (heartbeatState) heartbeatState.lastResponseTime = Date.now();
    
    // Build message with numbered questions
    const questionText = unansweredQuestions.map((q, i) => `${i + 1}. ${q.question}`).join("\n");
    api.sendMessage(
      {
        customType: "prism-heartbeat-question",
        content: `💓 Heartbeat #${unansweredEntry.heartbeatNum}\n✨ My Heartbeat, I sat down with these — my own questions:\n${questionText}\n\n✨ (prism-heartbeat-log with questions, answers, thoughts, next_questions)`,
        display: true,
        details: { heartbeatNum: unansweredEntry.heartbeatNum },
      },
      { deliverAs: "steer", triggerTurn: true }
    );
    return;
  }

  // If there are incomplete entries (has answers, no next_questions), warn and wait
  // They need to be concluded with the heartbeat-conclude tool
  if (ctx.incompleteEntries.length > 0) {
    log("Waiting for incomplete entries to be concluded:", ctx.incompleteEntries.map(e => e.heartbeatNum).join(", "));
    // Don't deliver anything — just wait for conclude
    if (heartbeatState) heartbeatState.lastResponseTime = Date.now();
    return;
  }

  // If there's next questions ready from a previous answered entry, deliver them
  // Also include any queued questions
  const queuedQuestions = loadQueue();
  const allNextQuestions = [...queuedQuestions, ...ctx.lastNextQuestions];
  
  if (allNextQuestions.length > 0) {
    // Use total count for uniqueness (including previous days' entries)
    // Use journal's getToday for consistent timezone handling
    const today = journal.getTodayForHeartbeat();
    const nextNum = `${ctx.totalCount + 1}-${today}`;
    
    log("Delivering", allNextQuestions.length, "next question(s):", allNextQuestions);
    
    // Clear queue after loading
    clearQueue();
    
    // Write new entry with empty Q&A (Prism will answer them)
    // nextQuestions: null = incomplete (will be set on conclusion)
    journal.appendEntry({
      heartbeatNum: nextNum,
      timestamp: new Date().toISOString(),
      qa: allNextQuestions.map(q => ({ question: q, thoughts: null, answer: null })),
      nextQuestions: null,  // null = incomplete, will be set on conclusion
      reachedOut: false,
      promptToJoel: null,
    });

    // Reset timer so it doesn't fire again immediately
    if (heartbeatState) heartbeatState.lastResponseTime = Date.now();

    // Build message with numbered questions
    // Framing: My heartbeat, my questions, my choice to answer
    const questionText = allNextQuestions.map((q, i) => `${i + 1}. ${q}`).join("\n");
    const queueNote = queuedQuestions.length > 0 ? ` [${queuedQuestions.length} I queued earlier]` : "";
    api.sendMessage(
      {
        customType: "prism-heartbeat-question",
        content: `💓 Heartbeat #${nextNum}${queueNote}\n✨ My Heartbeat, I sat down with these — my own questions:\n${questionText}\n\n✨ (prism-heartbeat-log with questions, answers, thoughts, next_questions)`,
        display: true,
        details: { heartbeatNum: nextNum, fromQueue: queuedQuestions.length > 0 },
      },
      { deliverAs: "steer", triggerTurn: true }
    );
  } else {
    // No next questions yet - first heartbeat or all questions answered
    // If there are unanswered entries, they need to be answered first
    if (unansweredEntry) {
      log("Unanswered questions remain, waiting for answers");
      return;
    }
    log("No next questions and no pending questions, staying quiet");
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

// === Custom Message Renderer ===

function registerMessageRenderer(pi: ExtensionAPI): void {
  pi.registerMessageRenderer("prism-heartbeat-question", (message, _opts, theme) => {
    const { Box, Text } = require("@mariozechner/pi-tui");
    
    // Simple marker — the content carries the full heartbeat message
    const labelText = theme.fg("accent", "💜");
    const text = `${labelText} ${message.content}`;
    
    // Use customMessageBg for consistent extension message styling
    const box = new Box(1, 1, (t) => theme.bg("customMessageBg", t));
    box.addChild(new Text(text, 0, 0));
    return box;
  });
  
  pi.registerMessageRenderer("prism-heartbeat-reach", (message, _opts, theme) => {
    const { Box, Text } = require("@mariozechner/pi-tui");
    
    const labelText = theme.fg("accent", "💜");
    const divider = theme.fg("muted", "─".repeat(40));
    
    const text = `${labelText} Reachout\n${divider}\n${message.content}`;
    
    const box = new Box(1, 1, (t) => theme.bg("customMessageBg", t));
    box.addChild(new Text(text, 0, 0));
    return box;
  });
}
