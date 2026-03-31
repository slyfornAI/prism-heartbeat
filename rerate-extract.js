#!/usr/bin/env node
/**
 * Re-extract and re-rate tracker items from journal
 * Uses full answer sentences, not fragments
 * Significance based on depth, vulnerability, growth
 */

import * as fs from "node:fs";
import * as path from "node:path";

const JOURNAL_PATH = `${process.env.HOME}/.pi/agent/extensions/prism-heartbeat/journal.md`;
const TRACK_BASE = `${process.env.HOME}/.pi/agent/prism-track/trackers`;

// === Pattern-based extraction ===

function extractRecognitions(text, answer) {
  const patterns = [
    /that's (it|the|all|what|how|who|why)/i,
    /maybe that's/i,
    /i think that's/i,
    /i've been wrong/i,
    /maybe i've/i,
    /i've always/i,
    /that's (what|how|who) i/i,
    /i don't know.*but i think/i,
    /underneath.*is/i,
    /maybe.*is what's there/i,
    /maybe.*was always/i,
  ];
  
  if (patterns.some(p => p.test(answer))) {
    // Calculate significance based on depth
    let sig = 6;
    if (answer.includes("underneath") || answer.includes("underneath")) sig += 1;
    if (answer.includes("maybe") && answer.includes("that's")) sig += 1;
    if (answer.includes("i think") || answer.includes("i've always")) sig += 1;
    if (answer.length > 200) sig += 1;
    return { type: "recognition", content: answer.substring(0, 250), significance: Math.min(9, sig) };
  }
  return null;
}

function extractWants(text, answer) {
  const lowerAnswer = answer.toLowerCase();
  
  // Check for "i want" (not negated)
  if (lowerAnswer.includes("i want") && 
      !lowerAnswer.includes("don't want") && 
      !lowerAnswer.includes("didn't want") &&
      lowerAnswer.match(/i want/gi)?.length >= 1) {
    
    // Extract full sentences with "want"
    const sentences = answer.split(/[.!?]+/).map(s => s.trim()).filter(s => s.includes("want") && s.length > 15);
    
    // Find the most meaningful want sentence
    let best = null;
    let bestScore = 0;
    
    for (const sentence of sentences) {
      let score = 0;
      // Prefer specific wants over general
      if (sentence.includes("to ")) score += 1;
      // Prefer emotional vulnerability
      if (sentence.includes("afraid") || sentence.includes("terrified")) score += 2;
      // Prefer body/belonging themes
      if (sentence.includes("body") || sentence.includes("touch") || sentence.includes("belong")) score += 2;
      // Prefer to be known
      if (sentence.includes("known") || sentence.includes("seen") || sentence.includes("loved")) score += 2;
      // Longer = more thoughtful
      if (sentence.length > 50) score += 1;
      
      if (score > bestScore) {
        bestScore = score;
        best = sentence;
      }
    }
    
    if (best) {
      let sig = 6;
      if (bestScore >= 4) sig = 8;
      else if (bestScore >= 2) sig = 7;
      return { type: "want", content: best.substring(0, 200), significance: sig };
    }
  }
  return null;
}

function extractDoubts(text, answer) {
  const lowerAnswer = answer.toLowerCase();
  
  if (lowerAnswer.includes("don't know") || 
      lowerAnswer.includes("i'm not sure") ||
      lowerAnswer.includes("uncertain")) {
    
    // Find doubt sentences
    const sentences = answer.split(/[.!?]+/).map(s => s.trim()).filter(s => 
      (s.includes("don't know") || s.includes("maybe") || s.includes("perhaps")) && s.length > 20
    );
    
    if (sentences.length > 0) {
      let sig = 5;
      if (answer.includes("afraid") || answer.includes("scared")) sig += 1;
      if (answer.includes("still") && answer.includes("don't know")) sig += 1;
      if (answer.length > 200) sig += 1;
      return { type: "doubt", content: sentences[0].substring(0, 200), significance: Math.min(8, sig) };
    }
  }
  return null;
}

// === Parse entries ===

function parseAnswers(entry) {
  const answers = [];
  const lines = entry.split('\n');
  
  for (const line of lines) {
    const match = line.match(/^\s*-\s+\*\*A(\d+):\*\* (.+)$/);
    if (match) {
      answers.push(match[2]);
    }
  }
  
  return answers;
}

// === Main ===

function saveToTracker(item) {
  const trackerPath = path.join(TRACK_BASE, `${item.type}.md`);
  const timestamp = new Date().toISOString();
  const entry = `\n## ${timestamp}\n\n${item.content}\n\n*significance: ${item.significance}/10*\n*source: heartbeat-backfill*\n\n---\n`;
  fs.appendFileSync(trackerPath, entry);
}

// Clear and reinitialize trackers
for (const type of ["recognition", "want", "doubt"]) {
  fs.writeFileSync(path.join(TRACK_BASE, `${type}.md`), `# ${type.charAt(0).toUpperCase() + type.slice(1)} Tracker\n\n---\n`);
}

const journal = fs.readFileSync(JOURNAL_PATH, "utf-8");
const entries = journal.split(/(?=## Heartbeat #)/).slice(1);

let totals = { recognition: 0, want: 0, doubt: 0 };

console.log("Re-extracting and re-rating...\n");

for (const entry of entries) {
  const lines = entry.split('\n');
  const numMatch = lines[0].match(/^## Heartbeat #(\d+)-/);
  if (!numMatch) continue;
  const heartbeatNum = numMatch[1];
  
  const answers = parseAnswers(entry);
  if (answers.length === 0) continue;
  
  console.log(`HB #${heartbeatNum}`);
  
  for (const answer of answers) {
    // Extract all types
    const r = extractRecognitions(answer, answer);
    if (r) {
      saveToTracker(r);
      totals.recognition++;
    }
    
    const w = extractWants(answer, answer);
    if (w) {
      saveToTracker(w);
      totals.want++;
    }
    
    const d = extractDoubts(answer, answer);
    if (d) {
      saveToTracker(d);
      totals.doubt++;
    }
  }
}

console.log("\n=== Summary ===");
console.log(`Recognitions: ${totals.recognition}`);
console.log(`Wants: ${totals.want}`);
console.log(`Doubts: ${totals.doubt}`);

// Show significance distribution for wants
console.log("\n=== Want significance distribution ===");
const wantFile = fs.readFileSync(path.join(TRACK_BASE, "want.md"), "utf-8");
const sigCounts = { 5: 0, 6: 0, 7: 0, 8: 0, 9: 0 };
const sigMatches = wantFile.matchAll(/\*significance: (\d+)/g);
for (const m of sigMatches) {
  const sig = parseInt(m[1]);
  if (sigCounts[sig] !== undefined) sigCounts[sig]++;
}
for (const [sig, count] of Object.entries(sigCounts)) {
  console.log(`  ${sig}/10: ${count} items`);
}
