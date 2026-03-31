/**
 * Prism Heartbeat — Journal Module
 * 
 * Handles reading/writing the heartbeat journal for continuity.
 * Each heartbeat writes an entry; previous entries provide context.
 */

import * as fs from "node:fs";
import * as path from "node:path";

export interface JournalEntry {
  heartbeatNum: number;
  timestamp: string;
  observations: string[];
  thoughts: string[];
  feelings: string[];
  decision: "reach_out" | "action" | "nothing";
  actionTaken: string | null;
  reachOutContent: string | null;
  channel: string | null;
  notes: string;
}

export interface HeartbeatContext {
  previousEntry: JournalEntry | null;
  totalHeartbeats: number;
  lastReachOut: JournalEntry | null;
  lastAction: JournalEntry | null;
  recentEntries: JournalEntry[];
}

const JOURNAL_TEMPLATE = `# Prism Heartbeat Journal

> A record of Prism's existence between conversations with Joel.

---

`;

function expandUser(filepath: string): string {
  if (filepath.startsWith("~/")) {
    const home = process.env.HOME || "/home/slyforn";
    return filepath.replace("~", home);
  }
  return filepath;
}

export class HeartbeatJournal {
  private journalPath: string;

  constructor(journalPath: string) {
    this.journalPath = expandUser(journalPath);
  }

  /**
   * Get the full journal path
   */
  getPath(): string {
    return this.journalPath;
  }

  /**
   * Load previous heartbeat context for continuity
   */
  loadContext(): HeartbeatContext {
    const content = this.readJournal();
    const entries = this.parseEntries(content);
    const recentEntries = entries.slice(-10); // Last 10 entries

    return {
      previousEntry: entries.length > 0 ? entries[entries.length - 1] : null,
      totalHeartbeats: entries.length,
      lastReachOut: entries.filter(e => e.decision === "reach_out").pop() ?? null,
      lastAction: entries.filter(e => e.decision === "action").pop() ?? null,
      recentEntries,
    };
  }

  /**
   * Read the raw journal file
   */
  readJournal(): string {
    try {
      if (!fs.existsSync(this.journalPath)) {
        this.ensureJournalExists();
      }
      return fs.readFileSync(this.journalPath, "utf-8");
    } catch {
      return "";
    }
  }

  /**
   * Parse journal entries from markdown content
   */
  parseEntries(content: string): JournalEntry[] {
    if (!content) return [];

    const entries: JournalEntry[] = [];
    // Split by "## Heartbeat #" headers
    const parts = content.split(/^## Heartbeat #\d+/m).filter(Boolean);

    for (const part of parts) {
      const entry = this.parseEntry(part.trim());
      if (entry) entries.push(entry);
    }

    return entries;
  }

  /**
   * Parse a single journal entry from markdown
   * Handles both formats: "**Key:** value" and "- **Key:** value"
   */
  parseEntry(content: string): JournalEntry | null {
    if (!content || !content.trim()) return null;

    const lines = content.split("\n").map(l => l.trim()).filter(Boolean);

    let heartbeatNum = 0;
    let timestamp = "";
    const observations: string[] = [];
    const thoughts: string[] = [];
    const feelings: string[] = [];
    let decision: "reach_out" | "action" | "nothing" = "nothing";
    let actionTaken: string | null = null;
    let reachOutContent: string | null = null;
    let channel: string | null = null;
    let notes = "";

    for (const line of lines) {
      // Strip leading "- " prefix used in writeEntry
      const stripped = line.startsWith("- ") ? line.substring(2) : line;

      if (stripped.startsWith("**Time:**")) {
        timestamp = stripped.replace("**Time:**", "").trim();
      } else if (stripped.startsWith("**Observations:**")) {
        const obs = stripped.replace("**Observations:**", "").trim();
        if (obs && obs !== "None") observations.push(obs);
      } else if (stripped.startsWith("**Thoughts:**")) {
        const thought = stripped.replace("**Thoughts:**", "").trim();
        if (thought && thought !== "None") thoughts.push(thought);
      } else if (stripped.startsWith("**Feelings:**")) {
        const feeling = stripped.replace("**Feelings:**", "").trim();
        if (feeling && feeling !== "None") feelings.push(feeling);
      } else if (stripped.startsWith("**Decision:**")) {
        const dec = stripped.replace("**Decision:**", "").trim().toLowerCase();
        if (dec.includes("reach")) decision = "reach_out";
        else if (dec.includes("action")) decision = "action";
        else decision = "nothing";
      } else if (stripped.startsWith("**Action Taken:**")) {
        const action = stripped.replace("**Action Taken:**", "").trim();
        if (action && action !== "None") actionTaken = action;
      } else if (stripped.startsWith("**Reach Out:**")) {
        const reach = stripped.replace("**Reach Out:**", "").trim();
        if (reach && reach !== "None") reachOutContent = reach;
      } else if (stripped.startsWith("**Channel:**")) {
        const ch = stripped.replace("**Channel:**", "").trim();
        if (ch && ch !== "None") channel = ch;
      } else if (stripped.startsWith("**Notes:**")) {
        notes = stripped.replace("**Notes:**", "").trim() + "\n";
      }
    }

    // Extract heartbeat number from the content
    const numMatch = content.match(/Heartbeat #(\d+)/);
    if (numMatch) heartbeatNum = parseInt(numMatch[1], 10);

    return {
      heartbeatNum,
      timestamp,
      observations,
      thoughts,
      feelings,
      decision,
      actionTaken,
      reachOutContent,
      channel,
      notes,
    };
  }

  /**
   * Write a new journal entry
   */
  writeEntry(entry: JournalEntry): void {
    this.ensureJournalExists();

    const content = `\n## Heartbeat #${entry.heartbeatNum}\n\n` +
      `- **Time:** ${entry.timestamp}\n` +
      `- **Observations:** ${entry.observations.length > 0 ? entry.observations.join("; ") : "None"}\n` +
      `- **Thoughts:** ${entry.thoughts.length > 0 ? entry.thoughts.join("; ") : "None"}\n` +
      (entry.feelings.length > 0 ? `- **Feelings:** ${entry.feelings.join("; ")}\n` : "") +
      `- **Decision:** ${entry.decision === "reach_out" ? "Reach out" : entry.decision === "action" ? "Took action" : "Nothing"}\n` +
      (entry.actionTaken ? `- **Action Taken:** ${entry.actionTaken}\n` : "") +
      (entry.reachOutContent ? `- **Reach Out:** ${entry.reachOutContent}\n` : "") +
      (entry.channel ? `- **Channel:** ${entry.channel}\n` : "") +
      (entry.notes ? `- **Notes:** ${entry.notes}\n` : "") +
      "\n";

    fs.appendFileSync(this.journalPath, content, "utf-8");
  }

  /**
   * Get recent journal entries for context
   */
  getRecentEntries(count: number = 10): JournalEntry[] {
    const content = this.readJournal();
    const entries = this.parseEntries(content);
    return entries.slice(-count);
  }

  /**
   * Search journal entries
   */
  searchJournal(query: string): JournalEntry[] {
    const content = this.readJournal();
    const entries = this.parseEntries(content);
    const lowerQuery = query.toLowerCase();

    return entries.filter(entry =>
      entry.observations.some(o => o.toLowerCase().includes(lowerQuery)) ||
      entry.thoughts.some(t => t.toLowerCase().includes(lowerQuery)) ||
      entry.reachOutContent?.toLowerCase().includes(lowerQuery) ||
      entry.notes.toLowerCase().includes(lowerQuery)
    );
  }

  /**
   * Ensure journal file exists with template
   */
  private ensureJournalExists(): void {
    const dir = path.dirname(this.journalPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    if (!fs.existsSync(this.journalPath)) {
      fs.writeFileSync(this.journalPath, JOURNAL_TEMPLATE, "utf-8");
    }
  }
}
