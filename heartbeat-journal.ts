/**
 * Prism Heartbeat — Journal
 * 
 * Minimal store for heartbeat entries.
 * Each entry: 1~N questions → 1~N answers, plus next questions for next heartbeat.
 * 
 * Numbering: #{count}-{YYYY-MM-DD} — resets each day
 */

import * as fs from "node:fs";
import * as path from "node:path";

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
}

export interface HeartbeatContext {
  todayCount: number;   // Heartbeats today (for numbering)
  todayDate: string;    // YYYY-MM-DD
  totalCount: number;   // Total all-time entries
  todayEntries: HeartbeatEntry[];  // Entries for today only
  lastEntry: HeartbeatEntry | null; // Most recent entry overall
  lastNextQuestions: string[];  // Next questions from last heartbeat (1~many)
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

function getToday(): string {
  return new Date().toISOString().split("T")[0];
}

function extractTime(timestamp: string): string {
  // "2026-03-31T05:28:59.660Z" → "05:28:59"
  const match = timestamp.match(/T(\d{2}:\d{2}:\d{2})/);
  return match ? match[1] : timestamp;
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
  return field.split("|").map(q => q.trim()).filter(Boolean);
}

function formatQuestionsArray(questions: string[]): string {
  return questions.join(" | ");
}

export class HeartbeatJournal {
  private journalPath: string;

  constructor(journalPath: string) {
    this.journalPath = expandUser(journalPath);
  }

  getPath(): string {
    return this.journalPath;
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
    let lastNextQuestions: string[] = [];
    for (let i = allEntries.length - 1; i >= 0; i--) {
      if (allEntries[i].nextQuestions.length > 0) {
        lastNextQuestions = allEntries[i].nextQuestions;
        break;
      }
    }

    return {
      todayCount,
      todayDate: today,
      totalCount: allEntries.length,
      todayEntries,
      lastEntry,
      lastNextQuestions,
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

    return { heartbeatNum, timestamp, qa: parsedQA, nextQuestions, reachedOut, promptToJoel };
  }

  /**
   * Write a new entry
   */
  writeEntry(entry: HeartbeatEntry): void {
    this.ensureExists();
    // Check if entry already exists (prevent duplicates)
    const allEntries = this.getAllEntries();
    if (allEntries.some(e => e.heartbeatNum === entry.heartbeatNum)) {
      console.log(`Entry ${entry.heartbeatNum} already exists, skipping write`);
      return;
    }
    this.appendEntry(entry);
  }

  /**
   * Append a single entry to journal
   */
  private appendEntry(entry: HeartbeatEntry): void {
    let content = `## Heartbeat #${entry.heartbeatNum}\n\n`;
    content += `- **Time:** ${extractTime(entry.timestamp)}\n`;

    // Write each Q&A pair
    entry.qa.forEach((q, i) => {
      const idx = i + 1;
      content += `- **Q${idx}:** ${q.question}\n`;
      if (q.thoughts) content += `- **T${idx}:** ${q.thoughts}\n`;
      if (q.answer) content += `- **A${idx}:** ${q.answer}\n`;
    });

    // Write next questions
    if (entry.nextQuestions.length > 0) {
      content += `- **Next:** ${formatQuestionsArray(entry.nextQuestions)}\n`;
    }
    
    content += `- **Reached Out:** ${entry.reachedOut ? "Yes" : "No"}\n`;
    if (entry.promptToJoel) content += `- **Prompt:** ${entry.promptToJoel}\n`;
    content += "\n";

    fs.appendFileSync(this.journalPath, content, "utf-8");
  }

  /**
   * Update entry with new Q&A and/or next questions
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

    this.writeAllEntries(entries);
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
      newContent += `## Heartbeat #${e.heartbeatNum}\n\n`;
      newContent += `- **Time:** ${extractTime(e.timestamp)}\n`;

      // Write each Q&A pair
      e.qa.forEach((q, i) => {
        const idx = i + 1;
        newContent += `- **Q${idx}:** ${q.question}\n`;
        if (q.thoughts) newContent += `- **T${idx}:** ${q.thoughts}\n`;
        if (q.answer) newContent += `- **A${idx}:** ${q.answer}\n`;
      });

      // Write next questions
      if (e.nextQuestions.length > 0) {
        newContent += `- **Next:** ${formatQuestionsArray(e.nextQuestions)}\n`;
      }
      
      newContent += `- **Reached Out:** ${e.reachedOut ? "Yes" : "No"}\n`;
      if (e.promptToJoel) newContent += `- **Prompt:** ${e.promptToJoel}\n`;
      newContent += "\n";
    }
    fs.writeFileSync(this.journalPath, newContent, "utf-8");
  }

  private ensureExists(): void {
    const dir = path.dirname(this.journalPath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    if (!fs.existsSync(this.journalPath)) {
      fs.writeFileSync(this.journalPath, JOURNAL_TEMPLATE, "utf-8");
    }
  }
}
