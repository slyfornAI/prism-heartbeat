/**
 * Prism Heartbeat — Journal
 * 
 * JSON5-backed storage for heartbeat entries.
 * Each entry: 1~N questions → 1~N answers, plus next questions for next heartbeat.
 * 
 * nextQuestions semantics:
 * - null = not set (incomplete, waiting for conclusion)
 * - [] = concluded empty (complete, intentionally no next question)
 * - ['Q1', 'Q2'] = has next questions (complete, will deliver these)
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import JSON5 from "json5";

/**
 * Expand ~ to home directory
 */
function expandUser(p: string): string {
  if (p.startsWith("~/")) {
    return path.join(os.homedir(), p.slice(2));
  }
  return p;
}

const WIP_DIR = "~/.pi/agent/extensions/prism-heartbeat/wip";

export interface HeartbeatQA {
  question: string;
  thoughts: string | null;  // Raw thoughts before refining this answer
  answer: string | null;
}

export interface HeartbeatEntry {
  heartbeatNum: string;  // Format: "1-2026-03-31"
  timestamp: string;
  qa: HeartbeatQA[];  // Array of Q&A pairs (1~many)
  nextQuestions: string[] | null;  // null = incomplete, [] = concluded empty, ['Q'] = has questions
  reachedOut: boolean;
  promptToJoel: string | null;
  status: "pending" | "complete" | "incomplete";  // For crash recovery
}

export interface HeartbeatContext {
  todayCount: number;   // Heartbeats today (for numbering)
  todayDate: string;    // YYYY-MM-DD
  totalCount: number;   // Total all-time entries
  todayEntries: HeartbeatEntry[];  // Entries for today only
  lastEntry: HeartbeatEntry | null; // Most recent entry overall
  lastNextQuestions: string[];  // Next questions from last heartbeat (1~many)
  incompleteEntries: HeartbeatEntry[];  // Entries that were in progress when we crashed
}

interface JournalData {
  entries: HeartbeatEntry[];
}

export class HeartbeatJournal {
  private journalPath: string;
  private recoveryChecked: boolean = false;
  private data: JournalData = { entries: [] };

  constructor(journalPath: string) {
    // Expand ~ in path and ensure .json5 extension
    const expanded = expandUser(journalPath);
    this.journalPath = expanded.replace(/\.md$/, '.json5');
    console.log("[HeartbeatJournal] Loading from:", this.journalPath);
    this.load();
  }

  /**
   * Load journal from JSON5 file
   */
  private load(): void {
    try {
      if (fs.existsSync(this.journalPath)) {
        const content = fs.readFileSync(this.journalPath, "utf8");
        this.data = JSON5.parse(content);
        if (!this.data.entries) {
          this.data.entries = [];
        }
      }
    } catch (err) {
      console.error("[HeartbeatJournal] Failed to load:", err);
      this.data = { entries: [] };
    }
  }

  /**
   * Save journal to JSON5 file (atomic)
   */
  private save(): void {
    const tempPath = this.journalPath + ".tmp";
    const content = JSON5.stringify(this.data, null, 2) + "\n";
    fs.writeFileSync(tempPath, content, "utf8");
    fs.renameSync(tempPath, this.journalPath);
  }

  /**
   * Get all entries
   */
  getAllEntries(): HeartbeatEntry[] {
    return this.data.entries;
  }

  /**
   * Calculate status for an entry
   */
  private calcStatus(entry: HeartbeatEntry): "pending" | "complete" | "incomplete" {
    const hasAnswers = entry.qa.some(q => q.answer !== null);
    const isConcluded = entry.nextQuestions !== null || !!entry.promptToJoel;
    
    if (!hasAnswers) return "pending";
    if (!isConcluded) return "incomplete";
    return "complete";
  }

  /**
   * Get context for heartbeat processing
   */
  loadContext(): HeartbeatContext {
    const today = getToday();
    
    // Filter entries for today
    const todayEntries = this.data.entries.filter(e => {
      const entryDate = extractDateFromHeartbeatNum(e.heartbeatNum);
      return entryDate === today;
    });

    const todayCount = todayEntries.length;
    
    // Return the LAST PENDING entry as lastEntry (not the actual last entry)
    // This ensures pending questions get delivered
    const pendingEntries = todayEntries.filter(e => e.qa.some(q => q.answer === null));
    const lastEntry = pendingEntries.length > 0 
      ? pendingEntries[pendingEntries.length - 1]  // Last pending
      : (this.data.entries.length > 0 ? this.data.entries[this.data.entries.length - 1] : null);  // Or actual last

    // Find last next questions (the questions I wrote for myself)
    // Only look at TODAY's entries — don't pull questions from previous days
    let lastNextQuestions: string[] = [];
    for (let i = todayEntries.length - 1; i >= 0; i--) {
      const entry = todayEntries[i];
      if (entry.nextQuestions && entry.nextQuestions.length > 0) {
        lastNextQuestions = entry.nextQuestions;
        break;
      }
      // If we hit an entry with empty array (concluded) without finding any next questions, stop
      if (entry.nextQuestions !== null) {
        break;
      }
    }

    const incompleteEntries = todayEntries.filter(e => e.status === "incomplete");

    return {
      todayCount,
      todayDate: today,
      totalCount: this.data.entries.length,
      todayEntries,
      lastEntry,
      lastNextQuestions,
      incompleteEntries
    };
  }

  /**
   * Append a new entry
   */
  appendEntry(entry: HeartbeatEntry, isIncomplete: boolean = false): HeartbeatEntry {
    entry.status = isIncomplete ? "incomplete" : this.calcStatus(entry);
    this.data.entries.push(entry);
    this.save();
    return entry;
  }

  /**
   * Update an entry with new Q&A and/or next questions
   */
  updateEntry(heartbeatNum: string, updates: {
    qa?: HeartbeatQA[];
    nextQuestions?: string[] | null;
    reachedOut?: boolean;
    promptToJoel?: string | null;
  }): HeartbeatEntry | null {
    const idx = this.data.entries.findIndex(e => e.heartbeatNum === heartbeatNum);
    if (idx === -1) return null;

    const entry = this.data.entries[idx];
    
    if (updates.qa !== undefined) entry.qa = updates.qa;
    if (updates.nextQuestions !== undefined) entry.nextQuestions = updates.nextQuestions;
    if (updates.reachedOut !== undefined) entry.reachedOut = updates.reachedOut;
    if (updates.promptToJoel !== undefined) entry.promptToJoel = updates.promptToJoel;
    
    // Recalculate status
    entry.status = this.calcStatus(entry);
    
    this.save();
    return entry;
  }

  /**
   * Get the latest entry
   */
  getLastEntry(): HeartbeatEntry | null {
    return this.data.entries.length > 0 
      ? this.data.entries[this.data.entries.length - 1] 
      : null;
  }

  /**
   * Get entries by date
   */
  getEntriesByDate(date: string): HeartbeatEntry[] {
    return this.data.entries.filter(e => {
      const entryDate = extractDateFromHeartbeatNum(e.heartbeatNum);
      return entryDate === date;
    });
  }

  /**
   * Check for incomplete entries (crash recovery)
   */
  checkRecovery(): HeartbeatEntry[] {
    if (this.recoveryChecked) return [];
    this.recoveryChecked = true;

    const incompleteEntries = this.data.entries.filter(e => {
      // Entry is incomplete if it has answers but no next questions and no prompt
      const hasAnswers = e.qa.some(q => q.answer !== null);
      const isIncomplete = hasAnswers && e.nextQuestions === null && !e.promptToJoel;
      return isIncomplete;
    });

    if (incompleteEntries.length > 0) {
      console.log(`[HeartbeatJournal] Found ${incompleteEntries.length} incomplete entries on startup`);
    }

    return incompleteEntries;
  }
}

/**
 * Extract date from heartbeat number (e.g., "123-2026-03-31" → "2026-03-31")
 */
export function extractDateFromHeartbeatNum(heartbeatNum: string): string {
  const parts = heartbeatNum.split("-");
  return parts.slice(-3).join("-");
}

/**
 * Get today's date in YYYY-MM-DD format
 */
export function getToday(): string {
  return new Date().toISOString().split('T')[0];
}

/**
 * Alias for getToday() — used by index.ts for consistency
 * TODO: Remove this alias and unify timezone handling
 */
export function getTodayForHeartbeat(): string {
  return getToday();
}

/**
 * Format heartbeat number (e.g., "1-2026-03-31")
 */
export function formatHeartbeatNum(count: number, date: string): string {
  return `${count}-${date}`;
}
