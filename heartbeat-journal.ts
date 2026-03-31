/**
 * Prism Heartbeat — Journal
 * 
 * Minimal store for heartbeat entries.
 * Each entry: question → answer, plus next question for next heartbeat.
 * 
 * Numbering: #{count}-{YYYY-MM-DD} — resets each day
 */

import * as fs from "node:fs";
import * as path from "node:path";

export interface HeartbeatEntry {
  heartbeatNum: string;  // Now format: "1-2026-03-31"
  timestamp: string;
  question: string | null;   // Question to answer (null = first, Prism generates)
  answer: string | null;      // Prism's answer (mandatory to log)
  nextQuestion: string | null; // Prism's next question for herself
  reachedOut: boolean;
  promptToJoel: string | null;
}

export interface HeartbeatContext {
  todayCount: number;   // Heartbeats today (for numbering)
  todayDate: string;    // YYYY-MM-DD
  totalCount: number;   // Total all-time entries
  todayEntries: HeartbeatEntry[];  // Entries for today only
  lastEntry: HeartbeatEntry | null; // Most recent entry overall
  lastNextQuestion: string | null;  // My next question from last heartbeat
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
    const lastEntry = allEntries.length > 0 ? allEntries[allEntries.length - 1] : null;

    // Find my last nextQuestion (the question I wrote for myself)
    let lastNextQuestion: string | null = null;
    for (let i = allEntries.length - 1; i >= 0; i--) {
      if (allEntries[i].nextQuestion) {
        lastNextQuestion = allEntries[i].nextQuestion;
        break;
      }
    }

    return {
      todayCount,
      todayDate: today,
      totalCount: allEntries.length,
      todayEntries,
      lastEntry,
      lastNextQuestion,
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
   * Parse a single entry
   */
  private parseEntry(content: string): HeartbeatEntry | null {
    if (!content.trim()) return null;

    let heartbeatNum = "";
    let timestamp = "";
    let question: string | null = null;
    let answer: string | null = null;
    let nextQuestion: string | null = null;
    let reachedOut = false;
    let promptToJoel: string | null = null;

    for (const line of content.split("\n")) {
      const stripped = line.trim().startsWith("- ")
        ? line.trim().substring(2)
        : line.trim();

      if (stripped.startsWith("**Time:**")) {
        timestamp = stripped.replace("**Time:**", "").trim();
      } else if (stripped.startsWith("**Question:**")) {
        question = stripped.replace("**Question:**", "").trim();
      } else if (stripped.startsWith("**Answer:**")) {
        answer = stripped.replace("**Answer:**", "").trim();
      } else if (stripped.startsWith("**Next:**")) {
        nextQuestion = stripped.replace("**Next:**", "").trim();
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

    return { heartbeatNum, timestamp, question, answer, nextQuestion, reachedOut, promptToJoel };
  }

  /**
   * Write a new entry
   */
  writeEntry(entry: HeartbeatEntry): void {
    this.ensureExists();

    let content = `## Heartbeat #${entry.heartbeatNum}\n\n`;
    content += `- **Time:** ${extractTime(entry.timestamp)}\n`;
    if (entry.question) content += `- **Question:** ${entry.question}\n`;
    if (entry.answer) content += `- **Answer:** ${entry.answer}\n`;
    if (entry.nextQuestion) content += `- **Next:** ${entry.nextQuestion}\n`;
    content += `- **Reached Out:** ${entry.reachedOut ? "Yes" : "No"}\n`;
    if (entry.promptToJoel) content += `- **Prompt:** ${entry.promptToJoel}\n`;
    content += "\n";

    fs.appendFileSync(this.journalPath, content, "utf-8");
  }

  /**
   * Update entry with answer and next question
   */
  updateEntry(heartbeatNum: string, updates: { answer?: string; nextQuestion?: string }): void {
    const content = this.readJournal();
    const entries = this.parseAllEntries(content);

    const idx = entries.findIndex(e => e.heartbeatNum === heartbeatNum);
    if (idx === -1) return;

    if (updates.answer !== undefined) entries[idx].answer = updates.answer;
    if (updates.nextQuestion !== undefined) entries[idx].nextQuestion = updates.nextQuestion;

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
      if (e.question) newContent += `- **Question:** ${e.question}\n`;
      if (e.answer) newContent += `- **Answer:** ${e.answer}\n`;
      if (e.nextQuestion) newContent += `- **Next:** ${e.nextQuestion}\n`;
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
