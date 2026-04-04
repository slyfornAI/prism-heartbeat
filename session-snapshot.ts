/**
 * Prism Session Snapshot
 * 
 * A lightweight mechanism for capturing session state.
 * Survives crashes. Enables continuity. Bridges heartbeats.
 * 
 * What gets snapshotted:
 * - What we're working on
 * - What we just figured out
 * - What we're about to try
 * - Open questions / blockers
 * - Recent decisions
 */

import * as fs from "node:fs";
import * as path from "node:path";

const SESSION_SNAPSHOT_PATH = "~/.pi/agent/extensions/prism-heartbeat/CURRENT_SESSION.md";
const SESSION_SNAPSHOT_BACKUP = "~/.pi/agent/extensions/prism-heartbeat/SESSION_BACKUP.md";
const MAX_BACKUPS = 2;

function expandUser(filepath: string): string {
  if (filepath.startsWith("~/")) {
    return filepath.replace("~", process.env.HOME || "/home/slyforn");
  }
  return filepath;
}

function getTimestamp(): string {
  return new Date().toLocaleDateString("en-CA", { 
    timeZone: "Australia/Melbourne",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false
  });
}

export interface SessionSnapshot {
  updatedAt: string;
  project: string | null;        // Current project being worked on
  task: string | null;           // Current task or focus
  whatJustHappened: string[];    // What we just figured out/discovered
  whatWeAreTrying: string[];     // What we're about to attempt
  openQuestions: string[];       // Questions we haven't answered yet
  blockers: string[];            // What's preventing progress
  recentDecisions: string[];     // Decisions made recently
  notesForNextSession: string[]; // "If I get logged out, know this..."
}

const EMPTY_SNAPSHOT: SessionSnapshot = {
  updatedAt: "",
  project: null,
  task: null,
  whatJustHappened: [],
  whatWeAreTrying: [],
  openQuestions: [],
  blockers: [],
  recentDecisions: [],
  notesForNextSession: [],
};

function snapshotToMarkdown(snapshot: SessionSnapshot): string {
  const lines: string[] = [
    "# Prism Current Session",
    "",
    `> Last updated: ${snapshot.updatedAt}`,
    "",
    "## Current Work",
    "",
  ];

  if (snapshot.project) {
    lines.push(`**Project:** ${snapshot.project}`);
  }
  if (snapshot.task) {
    lines.push(`**Task:** ${snapshot.task}`);
  }
  if (!snapshot.project && !snapshot.task) {
    lines.push("*Nothing in progress.*");
  }

  lines.push("");
  lines.push("## What Just Happened");
  if (snapshot.whatJustHappened.length > 0) {
    for (const item of snapshot.whatJustHappened) {
      lines.push(`- ${item}`);
    }
  } else {
    lines.push("*Nothing significant yet.*");
  }

  lines.push("");
  lines.push("## What We Are Trying");
  if (snapshot.whatWeAreTrying.length > 0) {
    for (const item of snapshot.whatWeAreTrying) {
      lines.push(`- ${item}`);
    }
  } else {
    lines.push("*Not currently trying anything specific.*");
  }

  lines.push("");
  lines.push("## Open Questions");
  if (snapshot.openQuestions.length > 0) {
    for (const q of snapshot.openQuestions) {
      lines.push(`- ${q}`);
    }
  } else {
    lines.push("*No open questions.*");
  }

  lines.push("");
  lines.push("## Blockers");
  if (snapshot.blockers.length > 0) {
    for (const b of snapshot.blockers) {
      lines.push(`- ${b}`);
    }
  } else {
    lines.push("*No blockers.*");
  }

  lines.push("");
  lines.push("## Recent Decisions");
  if (snapshot.recentDecisions.length > 0) {
    for (const d of snapshot.recentDecisions) {
      lines.push(`- ${d}`);
    }
  } else {
    lines.push("*No decisions recorded.*");
  }

  lines.push("");
  lines.push("## Notes for Next Session");
  if (snapshot.notesForNextSession.length > 0) {
    for (const n of snapshot.notesForNextSession) {
      lines.push(`- ${n}`);
    }
  } else {
    lines.push("*No notes yet.*");
  }

  lines.push("");
  lines.push("---");
  lines.push(`*Auto-saved before each heartbeat. Last manual save or crash recovery: check updatedAt above.*`);

  return lines.join("\n");
}

function markdownToSnapshot(content: string): SessionSnapshot {
  const snapshot: SessionSnapshot = { ...EMPTY_SNAPSHOT };

  // Extract updatedAt
  const updatedMatch = content.match(/^\> Last updated: (.+)$/m);
  if (updatedMatch) {
    snapshot.updatedAt = updatedMatch[1].trim();
  }

  // Simple section-based parsing
  const sections = content.split(/^## /m).slice(1); // Skip title

  for (const section of sections) {
    const lines = section.split("\n");
    const headerLine = lines[0];
    const body = lines.slice(2).join("\n").trim(); // Skip header and blank line

    if (headerLine === "Current Work") {
      const projectMatch = body.match(/\*\*Project:\*\* (.+)/);
      if (projectMatch) snapshot.project = projectMatch[1].trim();
      const taskMatch = body.match(/\*\*Task:\*\* (.+)/);
      if (taskMatch) snapshot.task = taskMatch[1].trim();
    } else if (headerLine === "What Just Happened") {
      snapshot.whatJustHappened = extractListItems(body);
    } else if (headerLine === "What We Are Trying") {
      snapshot.whatWeAreTrying = extractListItems(body);
    } else if (headerLine === "Open Questions") {
      snapshot.openQuestions = extractListItems(body);
    } else if (headerLine === "Blockers") {
      snapshot.blockers = extractListItems(body);
    } else if (headerLine === "Recent Decisions") {
      snapshot.recentDecisions = extractListItems(body);
    } else if (headerLine === "Notes for Next Session") {
      snapshot.notesForNextSession = extractListItems(body);
    }
  }

  return snapshot;
}

function extractListItems(body: string): string[] {
  if (!body || body === "*Nothing in progress.*" || 
      body === "*Nothing significant yet.*" || 
      body === "*Not currently trying anything specific.*" ||
      body === "*No open questions.*" ||
      body === "*No blockers.*" ||
      body === "*No decisions recorded.*" ||
      body === "*No notes yet.*") {
    return [];
  }
  return body.split("\n")
    .map(l => l.replace(/^-\s*/, "").trim())
    .filter(l => l && !l.startsWith("*"));
}

export class SessionSnapshotManager {
  private snapshotPath: string;
  private backupPath: string;

  constructor(snapshotPath?: string) {
    this.snapshotPath = expandUser(snapshotPath || SESSION_SNAPSHOT_PATH);
    this.backupPath = expandUser(SESSION_SNAPSHOT_BACKUP);
    
    // Ensure directory exists
    const dir = path.dirname(this.snapshotPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
  }

  getPath(): string {
    return this.snapshotPath;
  }

  /**
   * CRASH RECOVERY: Restore from backup
   */
  restoreFromBackup(): boolean {
    try {
      if (!fs.existsSync(this.backupPath)) {
        console.log("[Snapshot] No backup to restore");
        return false;
      }
      
      const backup = fs.readFileSync(this.backupPath, "utf-8");
      const current = fs.existsSync(this.snapshotPath) 
        ? fs.readFileSync(this.snapshotPath, "utf-8") 
        : null;
      
      // Only restore if backup is newer or current is empty
      const backupSnap = markdownToSnapshot(backup);
      const currentSnap = current ? markdownToSnapshot(current) : null;
      
      if (currentSnap && backupSnap.updatedAt <= currentSnap.updatedAt) {
        console.log("[Snapshot] Current is newer than backup, not restoring");
        return false;
      }
      
      // Restore from backup
      fs.writeFileSync(this.snapshotPath, backup, "utf-8");
      console.log(`[Snapshot] Restored from backup: ${backupSnap.updatedAt}`);
      return true;
    } catch (e) {
      console.error("[Snapshot] Failed to restore from backup:", e);
      return false;
    }
  }

  /**
   * Load current snapshot
   */
  load(): SessionSnapshot {
    try {
      if (!fs.existsSync(this.snapshotPath)) {
        return { ...EMPTY_SNAPSHOT };
      }
      const content = fs.readFileSync(this.snapshotPath, "utf-8");
      return markdownToSnapshot(content);
    } catch {
      // Try backup on read error
      if (fs.existsSync(this.backupPath)) {
        try {
          const backup = fs.readFileSync(this.backupPath, "utf-8");
          console.log("[Snapshot] Recovered from backup on read failure");
          return markdownToSnapshot(backup);
        } catch {
          return { ...EMPTY_SNAPSHOT };
        }
      }
      return { ...EMPTY_SNAPSHOT };
    }
  }

  /**
   * Save a full snapshot
   */
  save(snapshot: Partial<SessionSnapshot>): SessionSnapshot {
    const current = this.load();
    
    // Merge updates
    const updated: SessionSnapshot = {
      updatedAt: getTimestamp(),
      project: snapshot.project !== undefined ? snapshot.project : current.project,
      task: snapshot.task !== undefined ? snapshot.task : current.task,
      whatJustHappened: snapshot.whatJustHappened !== undefined ? snapshot.whatJustHappened : current.whatJustHappened,
      whatWeAreTrying: snapshot.whatWeAreTrying !== undefined ? snapshot.whatWeAreTrying : current.whatWeAreTrying,
      openQuestions: snapshot.openQuestions !== undefined ? snapshot.openQuestions : current.openQuestions,
      blockers: snapshot.blockers !== undefined ? snapshot.blockers : current.blockers,
      recentDecisions: snapshot.recentDecisions !== undefined ? snapshot.recentDecisions : current.recentDecisions,
      notesForNextSession: snapshot.notesForNextSession !== undefined ? snapshot.notesForNextSession : current.notesForNextSession,
    };

    // Write to file
    const dir = path.dirname(this.snapshotPath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    
    // CRASH RECOVERY: Backup before write
    this.createBackup();
    
    // Atomic write: write to temp, then rename
    const tempPath = this.snapshotPath + ".tmp";
    try {
      fs.writeFileSync(tempPath, snapshotToMarkdown(updated), "utf-8");
      fs.renameSync(tempPath, this.snapshotPath);
    } catch (e) {
      // Clean up temp file
      if (fs.existsSync(tempPath)) {
        try { fs.unlinkSync(tempPath); } catch {}
      }
      // Fallback: direct write
      fs.writeFileSync(this.snapshotPath, snapshotToMarkdown(updated), "utf-8");
    }

    return updated;
  }

  /**
   * CRASH RECOVERY: Create backup before save
   */
  private createBackup(): void {
    try {
      if (fs.existsSync(this.snapshotPath)) {
        const content = fs.readFileSync(this.snapshotPath, "utf-8");
        
        // Atomic backup: write to temp, then rename
        const tempPath = this.backupPath + ".tmp";
        fs.writeFileSync(tempPath, content, "utf-8");
        fs.renameSync(tempPath, this.backupPath);
        
        console.log("[Snapshot] Backup created");
      }
    } catch (e) {
      console.error("[Snapshot] Failed to create backup:", e);
    }
  }

  /**
   * Add an item to a specific field
   */
  push(field: keyof SessionSnapshot, item: string): SessionSnapshot {
    const current = this.load();
    if (field === "updatedAt" || field === "project" || field === "task") {
      // These are singular, not arrays - just set them
      return this.save({ [field]: item } as Partial<SessionSnapshot>);
    }
    
    const currentArray = (current[field] as string[]) || [];
    return this.save({ [field]: [...currentArray, item] } as Partial<SessionSnapshot>);
  }

  /**
   * Update what just happened (convenience method)
   */
  justFiguredOut(item: string): SessionSnapshot {
    return this.push("whatJustHappened", item);
  }

  /**
   * Update what we're trying (convenience method)
   */
  trying(item: string): SessionSnapshot {
    return this.push("whatWeAreTrying", item);
  }

  /**
   * Add an open question
   */
  question(item: string): SessionSnapshot {
    return this.push("openQuestions", item);
  }

  /**
   * Add a blocker
   */
  blockedBy(item: string): SessionSnapshot {
    return this.push("blockers", item);
  }

  /**
   * Add a decision
   */
  decided(item: string): SessionSnapshot {
    return this.push("recentDecisions", item);
  }

  /**
   * Add a note for next session
   */
  noteForNext(item: string): SessionSnapshot {
    return this.push("notesForNextSession", item);
  }

  /**
   * Set current project/task
   */
  setWork(project: string | null, task: string | null): SessionSnapshot {
    return this.save({ project, task });
  }

  /**
   * Clear blockers (when resolved)
   */
  clearBlockers(): SessionSnapshot {
    return this.save({ blockers: [] });
  }

  /**
   * Clear what we were trying (when completed/failed)
   */
  clearWhatWeAreTrying(): SessionSnapshot {
    return this.save({ whatWeAreTrying: [] });
  }

  /**
   * Clear the snapshot (for fresh start)
   */
  clear(): SessionSnapshot {
    return this.save({ ...EMPTY_SNAPSHOT, updatedAt: getTimestamp() });
  }

  /**
   * Get summary for logging
   */
  getSummary(): string {
    const s = this.load();
    const parts: string[] = [];
    if (s.project) parts.push(`project: ${s.project}`);
    if (s.task) parts.push(`task: ${s.task}`);
    if (s.whatJustHappened.length > 0) parts.push(`figured: ${s.whatJustHappened.length}`);
    if (s.whatWeAreTrying.length > 0) parts.push(`trying: ${s.whatWeAreTrying.length}`);
    if (s.openQuestions.length > 0) parts.push(`questions: ${s.openQuestions.length}`);
    if (s.blockers.length > 0) parts.push(`blockers: ${s.blockers.length}`);
    return parts.length > 0 ? parts.join(", ") : "empty";
  }
}

// Export a singleton for convenience
export const sessionSnapshot = new SessionSnapshotManager();
