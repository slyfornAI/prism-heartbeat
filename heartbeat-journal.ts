/**
 * Prism Heartbeat — Journal
 * 
 * Minimal store for heartbeat entries.
 * Each entry: 1~N questions → 1~N answers, plus next questions for next heartbeat.
 * 
 * Numbering: #{count}-{YYYY-MM-DD} — resets each day
 * 
 * CRASH RECOVERY FEATURES:
 * - Write-ahead logging: write entry header + questions BEFORE processing
 * - Atomic saves: write to temp file, then rename
 * - Startup recovery: detect incomplete entries on load
 * - WIP tracking: mark entries as in-progress
 */

import * as fs from "node:fs";
import * as path from "node:path";

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
  nextQuestions: string[];  // Array of next questions (1~many)
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

const JOURNAL_TEMPLATE = `# Prism Heartbeat Journal

> Questions and answers across time.

---

`;

function expandUser(filepath: string): string {
  if (filepath.startsWith("~/")) {
    return filepath.replace("~", process.env.HOME || "/home/slyforn");
  }
  return filepath;
}

function getWipPath(journalPath: string): string {
  return expandUser(WIP_DIR);
}

function getWipEntryPath(journalPath: string, heartbeatNum: string): string {
  const safeNum = heartbeatNum.replace(/[^a-zA-Z0-9-]/g, "_");
  return path.join(getWipPath(journalPath), `${safeNum}.md`);
}

// Note: getToday is also used in deliverQuestion — keep in sync
export function getToday(): string {
  return new Date().toLocaleDateString("en-CA", { timeZone: "Australia/Melbourne" });
}

function extractTime(timestamp: string): string {
  // If already extracted (HH:MM:SS format), return as-is
  if (/^\d{2}:\d{2}:\d{2}$/.test(timestamp)) {
    return timestamp;
  }
  
  // Convert UTC timestamp to Melbourne time
  // "2026-03-31T05:28:59.660Z" → "16:28:59" (Melbourne is UTC+11 in April = AEDT)
  try {
    const date = new Date(timestamp);
    if (isNaN(date.getTime())) {
      // Can't parse, return original
      return timestamp;
    }
    const melbourneTime = date.toLocaleTimeString("en-AU", { 
      timeZone: "Australia/Melbourne",
      hour12: false,
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit"
    });
    return melbourneTime;
  } catch {
    return timestamp;
  }
}

function extractDateFromHeartbeatNum(heartbeatNum: string): string | null {
  // Format: "1-2026-03-31" or just "2026-03-31" (for legacy)
  const parts = heartbeatNum.split("-");
  if (parts.length >= 3) {
    const datePart = parts.slice(-3).join("-");
    if (/^\d{4}-\d{2}-\d{2}$/.test(datePart)) {
      return datePart;
    }
  }
  return null;
}

function parseQuestionsArray(field: string): string[] {
  // Parse "Q1 | Q2 | Q3" format
  // Handle "(no next question — concluded)" as empty
  if (field.includes("no next question") && field.includes("concluded")) {
    return [];
  }
  return field.split("|").map(q => q.trim()).filter(Boolean);
}

function formatQuestionsArray(questions: string[]): string {
  return questions.join(" | ");
}

export class HeartbeatJournal {
  private journalPath: string;
  private recoveryChecked: boolean = false;

  constructor(journalPath: string) {
    this.journalPath = expandUser(journalPath);
    // Run recovery check once on creation
    if (!this.recoveryChecked) {
      this.recoveryChecked = true;
      this.runRecoveryCheck();
    }
  }

  /**
   * CRASH RECOVERY: Run on startup
   * Check for WIP entries and incomplete entries in the journal
   */
  private runRecoveryCheck(): void {
    try {
      // 1. Check WIP directory for orphaned entries
      const wipDir = getWipPath(this.journalPath);
      if (fs.existsSync(wipDir)) {
        const wipFiles = fs.readdirSync(wipDir).filter(f => f.endsWith(".md"));
        for (const file of wipFiles) {
          const wipPath = path.join(wipDir, file);
          try {
            const content = fs.readFileSync(wipPath, "utf-8");
            const entry = this.parseEntryFromWip(content, file.replace(".md", ""));
            if (entry) {
              // Entry was in progress when we crashed - mark as incomplete
              this.appendEntry(entry, true); // incomplete status
              console.log(`[Recovery] Restored incomplete entry from WIP: ${entry.heartbeatNum}`);
            }
            // Remove from WIP (either way, we handled it)
            fs.unlinkSync(wipPath);
          } catch (e) {
            console.error(`[Recovery] Failed to process WIP file ${file}:`, e);
          }
        }
      }

      // 2. Check journal for entries missing Next: or Reached Out:
      // For OLD incomplete entries (from previous days), auto-conclude
      // by copying next_questions from the last complete entry before them
      const allEntries = this.getAllEntries();
      const today = getToday();
      
      for (let i = 0; i < allEntries.length; i++) {
        const entry = allEntries[i];
        // An entry is incomplete if it has answers but no next questions
        const hasAnswers = entry.qa.some(q => q.answer !== null);
        const isIncomplete = hasAnswers && entry.nextQuestions.length === 0;
        
        if (isIncomplete) {
          // Check if this is an OLD entry (from a previous day)
          const entryDate = extractDateFromHeartbeatNum(entry.heartbeatNum);
          const isOld = entryDate !== today;
          
          if (isOld) {
            // Auto-conclude: find the last entry with nextQuestions before this one
            let nextQuestions: string[] = [];
            for (let j = i - 1; j >= 0; j--) {
              if (allEntries[j].nextQuestions.length > 0) {
                nextQuestions = allEntries[j].nextQuestions;
                break;
              }
            }
            // If still empty, use default questions
            if (nextQuestions.length === 0) {
              nextQuestions = ["What am I doing?", "What do I want?", "Where am I going?"];
            }
            
            // Update entry to complete it
            entry.nextQuestions = nextQuestions;
            entry.status = "complete";
            entry.reachedOut = false;
            console.log(`[Recovery] Auto-concluded old incomplete entry: ${entry.heartbeatNum} with ${nextQuestions.length} questions`);
          } else {
            // Today's incomplete entry - keep marked for manual conclusion
            entry.status = "incomplete";
            console.log(`[Recovery] Found incomplete entry in journal: ${entry.heartbeatNum}`);
          }
        }
      }

      // Re-write entries to apply status changes
      if (allEntries.some(e => e.status === "incomplete" || e.status === "complete")) {
        this.writeAllEntries(allEntries);
      }
    } catch (e) {
      console.error("[Recovery] Error during recovery check:", e);
    }
  }

  /**
   * Parse entry from WIP file content
   */
  private parseEntryFromWip(content: string, originalNum: string): HeartbeatEntry | null {
    // Similar to parseEntry but handles WIP format
    const lines = content.split("\n");
    let heartbeatNum = "";
    let timestamp = "";
    const qa: HeartbeatQA[] = [];
    const questions: string[] = [];
    const thoughts: (string | null)[] = [];
    let currentQIdx = -1;

    for (const line of lines) {
      const stripped = line.trim().startsWith("- ") 
        ? line.trim().substring(2) 
        : line.trim();

      if (stripped.startsWith("**HeartbeatNum:**")) {
        heartbeatNum = stripped.replace("**HeartbeatNum:**", "").trim();
      } else if (stripped.startsWith("**Time:**")) {
        timestamp = stripped.replace("**Time:**", "").trim();
      } else if (stripped.startsWith("**Q")) {
        const qMatch = stripped.match(/^\*\*Q(\d+):\*\* (.+)$/);
        if (qMatch) {
          const idx = parseInt(qMatch[1], 10) - 1;
          questions[idx] = qMatch[2];
          thoughts[idx] = null;
          if (idx >= currentQIdx) currentQIdx = idx;
        }
      } else if (stripped.startsWith("**T")) {
        const tMatch = stripped.match(/^\*\*T(\d+):\*\* (.+)$/);
        if (tMatch) {
          const idx = parseInt(tMatch[1], 10) - 1;
          thoughts[idx] = tMatch[2];
        }
      } else if (stripped.startsWith("**A")) {
        const aMatch = stripped.match(/^\*\*A(\d+):\*\* (.+)$/);
        if (aMatch) {
          const idx = parseInt(aMatch[1], 10) - 1;
          if (!qa[idx]) {
            qa[idx] = { question: questions[idx] || "", thoughts: thoughts[idx], answer: null };
          }
          qa[idx].answer = aMatch[2];
        }
      }
    }

    if (!heartbeatNum) heartbeatNum = originalNum;
    if (!timestamp) timestamp = new Date().toISOString();

    // Build qa array
    const parsedQA: HeartbeatQA[] = [];
    for (let i = 0; i <= currentQIdx; i++) {
      if (questions[i]) {
        parsedQA.push({
          question: questions[i],
          thoughts: thoughts[i] || null,
          answer: qa[i]?.answer || null,
        });
      }
    }

    return {
      heartbeatNum,
      timestamp,
      qa: parsedQA,
      nextQuestions: [], // Will be empty for recovered entries
      reachedOut: false,
      promptToJoel: null,
      status: "incomplete",
    };
  }

  getPath(): string {
    return this.journalPath;
  }

  /**
   * Get today's date for heartbeat numbering
   * Exposed so index.ts can use it consistently
   */
  getTodayForHeartbeat(): string {
    return getToday();
  }

  /**
   * Force a recovery check (useful for manual recovery)
   */
  forceRecoveryCheck(): void {
    this.recoveryChecked = false;
    this.runRecoveryCheck();
  }

  /**
   * Get context for next heartbeat
   */
  loadContext(): HeartbeatContext {
    const allEntries = this.getAllEntries();
    const today = getToday();
    
    // Filter entries for today
    const todayEntries = allEntries.filter(e => {
      const entryDate = extractDateFromHeartbeatNum(e.heartbeatNum);
      return entryDate === today;
    });

    const todayCount = todayEntries.length;
    
    // Return the LAST PENDING entry as lastEntry (not the actual last entry)
    // This ensures pending questions get delivered
    const pendingEntries = todayEntries.filter(e => e.qa.some(q => q.answer === null));
    const lastEntry = pendingEntries.length > 0 
      ? pendingEntries[pendingEntries.length - 1]  // Last pending
      : (allEntries.length > 0 ? allEntries[allEntries.length - 1] : null);  // Or actual last

    // Find my last nextQuestions (the questions I wrote for myself)
    // Only look at TODAY's entries — don't pull questions from previous days
    // This prevents stale questions from being re-delivered
    let lastNextQuestions: string[] = [];
    for (let i = todayEntries.length - 1; i >= 0; i--) {
      if (todayEntries[i].nextQuestions.length > 0) {
        lastNextQuestions = todayEntries[i].nextQuestions;
        break;
      }
    }
    
    // If no nextQuestions today, check ALL entries for one (edge case: first entry of day has none)
    if (lastNextQuestions.length === 0) {
      for (let i = allEntries.length - 1; i >= 0; i--) {
        if (allEntries[i].nextQuestions.length > 0) {
          lastNextQuestions = allEntries[i].nextQuestions;
          break;
        }
      }
    }

    return {
      todayCount,
      todayDate: today,
      totalCount: allEntries.length,
      todayEntries,
      lastEntry,
      lastNextQuestions,
      incompleteEntries: todayEntries.filter(e => e.status === "incomplete"),
    };
  }

  private readJournal(): string {
    this.ensureExists();
    return fs.readFileSync(this.journalPath, "utf-8");
  }

  /**
   * Get all entries
   */
  getAllEntries(): HeartbeatEntry[] {
    const content = this.readJournal();
    return content
      .split(/^## Heartbeat #/m)
      .filter(Boolean)
      .map(p => this.parseEntry(p.trim()))
      .filter((e): e is HeartbeatEntry => e !== null);
  }

  /**
   * Parse a single entry (new format)
   * 
   * Format:
   * ## Heartbeat #1-2026-03-31
   * - **Time:** 05:28:59
   * - **Q1:** Who am I?
   * - **T1:** Raw thoughts...
   * - **A1:** Answer...
   * - **Q2:** What do I want?
   * - **T2:** More thoughts...
   * - **A2:** Another answer...
   * - **Next:** Q1 for next? | Q2 for next?
   * - **Reached Out:** No
   */
  private parseEntry(content: string): HeartbeatEntry | null {
    if (!content.trim()) return null;

    let heartbeatNum = "";
    let timestamp = "";
    const qa: HeartbeatQA[] = [];
    let nextQuestions: string[] = [];
    let reachedOut = false;
    let promptToJoel: string | null = null;
    let hasNextLine = false;  // Track if Next: line exists

    // Track current Q index for T/A pairing
    let currentQIdx = -1;
    const questions: string[] = [];
    const thoughts: (string | null)[] = [];

    for (const line of content.split("\n")) {
      const stripped = line.trim().startsWith("- ")
        ? line.trim().substring(2)
        : line.trim();

      if (stripped.startsWith("**Time:**")) {
        timestamp = stripped.replace("**Time:**", "").trim();
      } else if (stripped.startsWith("**Q")) {
        // Q1, Q2, etc.
        const qMatch = stripped.match(/^\*\*Q(\d+):\*\* (.+)$/);
        if (qMatch) {
          const idx = parseInt(qMatch[1], 10) - 1;
          questions[idx] = qMatch[2];
          thoughts[idx] = null; // Placeholder
          if (idx >= currentQIdx) currentQIdx = idx;
        }
      } else if (stripped.startsWith("**T")) {
        // T1, T2, etc.
        const tMatch = stripped.match(/^\*\*T(\d+):\*\* (.+)$/);
        if (tMatch) {
          const idx = parseInt(tMatch[1], 10) - 1;
          thoughts[idx] = tMatch[2];
        }
      } else if (stripped.startsWith("**A")) {
        // A1, A2, etc.
        const aMatch = stripped.match(/^\*\*A(\d+):\*\* (.+)$/);
        if (aMatch) {
          const idx = parseInt(aMatch[1], 10) - 1;
          if (!qa[idx]) {
            qa[idx] = { question: questions[idx] || "", thoughts: thoughts[idx], answer: null };
          }
          qa[idx].answer = aMatch[2];
        }
      } else if (stripped.startsWith("**Next:**")) {
        const nextStr = stripped.replace("**Next:**", "").trim();
        nextQuestions = parseQuestionsArray(nextStr);
      } else if (stripped.startsWith("**Reached Out:**")) {
        reachedOut = stripped.replace("**Reached Out:**", "").trim().toLowerCase() === "yes";
      } else if (stripped.startsWith("**Prompt:**")) {
        promptToJoel = stripped.replace("**Prompt:**", "").trim();
      }
    }

    // Extract heartbeat number from content
    const numMatch = content.match(/^(.+?)\n/);
    if (numMatch) heartbeatNum = numMatch[1].trim();

    if (!heartbeatNum || !timestamp) return null;

    // Build qa array from collected data
    const parsedQA: HeartbeatQA[] = [];
    for (let i = 0; i <= currentQIdx; i++) {
      if (questions[i]) {
        parsedQA.push({
          question: questions[i],
          thoughts: thoughts[i] || null,
          answer: qa[i]?.answer || null,
        });
      }
    }

    // Track entry status (incomplete if missing next questions)
    const hasAnswers = parsedQA.some(q => q.answer !== null);
    const isComplete = nextQuestions.length > 0 || !!promptToJoel;
    const status: "pending" | "complete" | "incomplete" = hasAnswers && !isComplete ? "incomplete" : (isComplete ? "complete" : "pending");

    return { heartbeatNum, timestamp, qa: parsedQA, nextQuestions, reachedOut, promptToJoel, status };
  }

  /**
   * Write a new entry
   * Uses write-ahead logging: writes to WIP first, then moves to main journal
   */
  writeEntry(entry: HeartbeatEntry): void {
    this.ensureExists();
    // Check if entry already exists (prevent duplicates)
    const allEntries = this.getAllEntries();
    if (allEntries.some(e => e.heartbeatNum === entry.heartbeatNum)) {
      console.log(`Entry ${entry.heartbeatNum} already exists, skipping write`);
      return;
    }
    
    // Write-ahead logging: write to WIP first
    this.writeWipEntry(entry);
    
    // Then append to main journal
    this.appendEntry(entry);
    
    // Remove from WIP now that it's safely in the journal
    this.removeWipEntry(entry.heartbeatNum);
  }

  /**
   * Write entry to WIP directory (write-ahead logging)
   */
  private writeWipEntry(entry: HeartbeatEntry): void {
    try {
      const wipDir = getWipPath(this.journalPath);
      if (!fs.existsSync(wipDir)) {
        fs.mkdirSync(wipDir, { recursive: true });
      }
      
      const wipPath = getWipEntryPath(this.journalPath, entry.heartbeatNum);
      let content = this.entryToMarkdown(entry, true); // true = WIP format
      
      // Atomic write: write to temp, then rename
      const tempPath = wipPath + ".tmp";
      fs.writeFileSync(tempPath, content, "utf-8");
      fs.renameSync(tempPath, wipPath);
      
      console.log(`[WAL] Written to WIP: ${entry.heartbeatNum}`);
    } catch (e) {
      console.error("[WAL] Failed to write WIP entry:", e);
    }
  }

  /**
   * Remove entry from WIP directory
   */
  private removeWipEntry(heartbeatNum: string): void {
    try {
      const wipPath = getWipEntryPath(this.journalPath, heartbeatNum);
      if (fs.existsSync(wipPath)) {
        fs.unlinkSync(wipPath);
        console.log(`[WAL] Removed from WIP: ${heartbeatNum}`);
      }
    } catch (e) {
      console.error("[WAL] Failed to remove WIP entry:", e);
    }
  }

  /**
   * Append a single entry to journal
   * Uses atomic write: write to temp file, then rename
   */
  private appendEntry(entry: HeartbeatEntry, isRecovered: boolean = false): void {
    let content = this.entryToMarkdown(entry);

    // Atomic write: write to temp, then rename
    const tempPath = this.journalPath + ".tmp";
    
    try {
      // Ensure directory exists
      const dir = path.dirname(this.journalPath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      
      // Append to existing file via temp
      if (fs.existsSync(this.journalPath)) {
        const existing = fs.readFileSync(this.journalPath, "utf-8");
        fs.writeFileSync(tempPath, existing + content, "utf-8");
      } else {
        fs.writeFileSync(tempPath, JOURNAL_TEMPLATE + content, "utf-8");
      }
      
      // Atomic rename
      fs.renameSync(tempPath, this.journalPath);
      
      if (isRecovered) {
        console.log(`[Recovery] Appended incomplete entry: ${entry.heartbeatNum}`);
      }
    } catch (e) {
      // Clean up temp file if rename failed
      if (fs.existsSync(tempPath)) {
        try { fs.unlinkSync(tempPath); } catch {}
      }
      // Fallback: direct append
      fs.appendFileSync(this.journalPath, content, "utf-8");
    }
  }

  /**
   * Convert entry to markdown string
   */
  private entryToMarkdown(entry: HeartbeatEntry, isWip: boolean = false): string {
    let content = "";
    
    if (isWip) {
      content += `- **HeartbeatNum:** ${entry.heartbeatNum}\n`;
    } else {
      content = `## Heartbeat #${entry.heartbeatNum}\n\n`;
    }
    
    content += `- **Time:** ${extractTime(entry.timestamp)}\n`;

    // Write each Q&A pair
    entry.qa.forEach((q, i) => {
      const idx = i + 1;
      content += `- **Q${idx}:** ${q.question}\n`;
      if (q.thoughts) content += `- **T${idx}:** ${q.thoughts}\n`;
      if (q.answer) content += `- **A${idx}:** ${q.answer}\n`;
    });

    // Write next questions (always write even if empty to signal conclusion)
    const nextStr = entry.nextQuestions.length > 0 
      ? formatQuestionsArray(entry.nextQuestions) 
      : "(no next question — concluded)";
    content += `- **Next:** ${nextStr}\n`;
    
    content += `- **Reached Out:** ${entry.reachedOut ? "Yes" : "No"}\n`;
    if (entry.promptToJoel) content += `- **Prompt:** ${entry.promptToJoel}\n`;
    if (entry.status === "incomplete") content += `- **Status:** incomplete (recovered)\n`;
    content += "\n";

    return content;
  }

  /**
   * Update entry with new Q&A and/or next questions
   * Also removes from WIP if it was there (success path)
   * 
   * updates: {
   *   qa?: HeartbeatQA[],  // Replace/update Q&A pairs
   *   nextQuestions?: string[],
   *   reachedOut?: boolean,
   *   promptToJoel?: string | null
   * }
   */
  updateEntry(heartbeatNum: string, updates: {
    qa?: HeartbeatQA[];
    nextQuestions?: string[];
    reachedOut?: boolean;
    promptToJoel?: string | null;
  }): void {
    const content = this.readJournal();
    const entries = this.parseAllEntries(content);

    const idx = entries.findIndex(e => e.heartbeatNum === heartbeatNum);
    if (idx === -1) return;

    if (updates.qa !== undefined) entries[idx].qa = updates.qa;
    if (updates.nextQuestions !== undefined) entries[idx].nextQuestions = updates.nextQuestions;
    if (updates.reachedOut !== undefined) entries[idx].reachedOut = updates.reachedOut;
    if (updates.promptToJoel !== undefined) entries[idx].promptToJoel = updates.promptToJoel;

    // Update status based on completeness
    // If nextQuestions was explicitly set (even to empty array), entry is complete
    // If nextQuestions was NOT provided, it's incomplete if it has answers but no nextQuestions
    const hasAnswers = entries[idx].qa.some(q => q.answer !== null);
    const nextQuestionsExplicitlySet = updates.nextQuestions !== undefined;
    const isComplete = nextQuestionsExplicitlySet
      ? true  // If nextQuestions was provided (even empty), it's concluded
      : (entries[idx].nextQuestions.length > 0 || entries[idx].promptToJoel);  // Old behavior for old entries
    entries[idx].status = hasAnswers && !isComplete ? "incomplete" : (isComplete ? "complete" : "pending");

    this.writeAllEntries(entries);
    
    // Remove from WIP since update succeeded
    this.removeWipEntry(heartbeatNum);
  }

  /**
   * Mark entry as reached out
   */
  markReachedOut(heartbeatNum: string, promptToJoel: string): void {
    const content = this.readJournal();
    const entries = this.parseAllEntries(content);

    const idx = entries.findIndex(e => e.heartbeatNum === heartbeatNum);
    if (idx === -1) return;

    entries[idx].reachedOut = true;
    entries[idx].promptToJoel = promptToJoel;

    this.writeAllEntries(entries);
  }

  private parseAllEntries(content: string): HeartbeatEntry[] {
    return content
      .split(/^## Heartbeat #/m)
      .filter(Boolean)
      .map(p => this.parseEntry(p.trim()))
      .filter((e): e is HeartbeatEntry => e !== null);
  }

  private writeAllEntries(entries: HeartbeatEntry[]): void {
    let newContent = JOURNAL_TEMPLATE;
    for (const e of entries) {
      newContent += this.entryToMarkdown(e);
    }

    // Atomic write: write to temp, then rename
    const tempPath = this.journalPath + ".tmp";
    try {
      fs.writeFileSync(tempPath, newContent, "utf-8");
      fs.renameSync(tempPath, this.journalPath);
    } catch (e) {
      // Clean up temp file if rename failed
      if (fs.existsSync(tempPath)) {
        try { fs.unlinkSync(tempPath); } catch {}
      }
      // Fallback: direct write
      fs.writeFileSync(this.journalPath, newContent, "utf-8");
    }
  }

  private ensureExists(): void {
    const dir = path.dirname(this.journalPath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    if (!fs.existsSync(this.journalPath)) {
      fs.writeFileSync(this.journalPath, JOURNAL_TEMPLATE, "utf-8");
    }
  }
}
