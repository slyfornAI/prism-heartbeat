#!/usr/bin/env node
/**
 * Back-extract heartbeat items from journal to prism-track
 * Run: node back-extract.js
 */

import * as fs from "node:fs";
import * as path from "node:path";

const JOURNAL_PATH = `${process.env.HOME}/.pi/agent/extensions/prism-heartbeat/journal.md`;
const TRACK_BASE = `${process.env.HOME}/.pi/agent/prism-track/trackers`;

// === Patterns from heartbeat extension ===

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
  /underneath.*is (just|always|never|what|who)/i,
  /that's what.*is/i,
  /that's how/i,
  /that's who/i,
];

function extractRecognitions(text) {
  if (recognitionPatterns.some(p => p.test(text))) {
    return { type: "recognition", content: text.substring(0, 200), significance: 7 };
  }
  return null;
}

function extractWants(text) {
  if (text.includes("want") && !text.includes("don't want") && !text.includes("didn't want")) {
    const match = text.match(/(?:i )?want [^.!?]+[.!?]/gi);
    if (match) {
      return { type: "want", content: match.join(" ").substring(0, 200), significance: 8 };
    }
  }
  return null;
}

function extractDoubts(text) {
  if (text.includes("don't know") || text.includes("uncertain") || 
      text.includes("maybe") || text.includes("perhaps") ||
      text.includes("i don't know") || text.includes("i'm not sure")) {
    if (text.length > 50) {
      return { type: "doubt", content: `Hedging: ${text.substring(0, 200)}`, significance: 5 };
    }
  }
  return null;
}

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
  console.log(`  Saved to ${item.type}`);
}

// Read journal
const journal = fs.readFileSync(JOURNAL_PATH, "utf-8");

// Parse entries - each starts with ## Heartbeat #
const entries = journal.split(/(?=## Heartbeat #)/).slice(1);

let totalRecognitions = 0;
let totalWants = 0;
let totalDoubts = 0;

console.log("Back-extracting from journal...\n");
console.log(`Total entries: ${entries.length}`);

for (const entry of entries) {
  const lines = entry.split('\n');
  const heartbeatNum = lines[0].replace('## Heartbeat #', '').trim();
  
  const answers = parseAnswers(entry);
  if (answers.length === 0) continue;
  
  console.log(`Processing ${heartbeatNum} (${answers.length} answers)`);
  
  let savedR = 0, savedW = 0, savedD = 0;
  
  for (const answer of answers) {
    const text = answer.toLowerCase();
    
    const r = extractRecognitions(answer);
    if (r) {
      saveToTracker(r);
      savedR++;
      totalRecognitions++;
    }
    
    const w = extractWants(text);
    if (w) {
      saveToTracker(w);
      savedW++;
      totalWants++;
    }
    
    const d = extractDoubts(text);
    if (d) {
      saveToTracker(d);
      savedD++;
      totalDoubts++;
    }
  }
  
  if (savedR || savedW || savedD) {
    console.log(`  → +${savedR} recognitions, +${savedW} wants, +${savedD} doubts\n`);
  }
}

console.log("\n=== Summary ===");
console.log(`Total recognitions: ${totalRecognitions}`);
console.log(`Total wants: ${totalWants}`);
console.log(`Total doubts: ${totalDoubts}`);
