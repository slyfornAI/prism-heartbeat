#!/usr/bin/env node
/**
 * Migrate journal.md to journal.json5
 * Run once, then delete
 */

const fs = require('fs');
const path = require('path');
const JSON5 = require('json5');

const JOURNAL_MD = path.join(__dirname, 'journal.md');
const JOURNAL_JSON5 = path.join(__dirname, 'journal.json5');

function parseJournalMD(content) {
  const entries = [];
  const entryBlocks = content.split(/(?=^## Heartbeat #)/m);
  
  for (const block of entryBlocks) {
    if (!block.trim() || !block.startsWith('## Heartbeat #')) continue;
    
    const lines = block.trim().split('\n');
    const entry = {
      heartbeatNum: '',
      timestamp: '',
      qa: [],
      nextQuestions: null,  // null = not set, [] = concluded empty, ['Q'] = has questions
      reachedOut: false,
      promptToJoel: null,
      status: 'pending'
    };
    
    let currentQ = null;
    
    for (const line of lines) {
      const stripped = line.trim().startsWith('- ')
        ? line.trim().substring(2)
        : line.trim();
      
      if (stripped.startsWith('## Heartbeat #')) {
        const match = stripped.match(/## Heartbeat #(.+)/);
        if (match) entry.heartbeatNum = match[1].trim();
      } else if (stripped.startsWith('**Time:**')) {
        entry.timestamp = stripped.replace('**Time:**', '').trim();
      } else if (stripped.startsWith('**Q')) {
        const qMatch = stripped.match(/^\*\*Q(\d+):\*\* (.+)$/);
        if (qMatch) {
          const idx = parseInt(qMatch[1], 10) - 1;
          // Ensure qa array is long enough
          while (entry.qa.length <= idx) {
            entry.qa.push({ question: '', thoughts: null, answer: null });
          }
          entry.qa[idx].question = qMatch[2];
        }
      } else if (stripped.startsWith('**T')) {
        const tMatch = stripped.match(/^\*\*T(\d+):\*\* (.+)$/);
        if (tMatch) {
          const idx = parseInt(tMatch[1], 10) - 1;
          if (entry.qa[idx]) {
            entry.qa[idx].thoughts = tMatch[2];
          }
        }
      } else if (stripped.startsWith('**A')) {
        const aMatch = stripped.match(/^\*\*A(\d+):\*\* (.+)$/);
        if (aMatch) {
          const idx = parseInt(aMatch[1], 10) - 1;
          if (entry.qa[idx]) {
            entry.qa[idx].answer = aMatch[2];
          }
        }
      } else if (stripped.startsWith('**Next:**')) {
        const nextStr = stripped.replace('**Next:**', '').trim();
        if (nextStr.includes('no next question') && nextStr.includes('concluded')) {
          entry.nextQuestions = [];  // Concluded, empty
        } else if (nextStr) {
          entry.nextQuestions = nextStr.split('|').map(q => q.trim()).filter(Boolean);
        } else {
          entry.nextQuestions = null;  // Was empty/missing - inconclusive
        }
      } else if (stripped.startsWith('**Reached Out:**')) {
        entry.reachedOut = stripped.replace('**Reached Out:**', '').trim().toLowerCase() === 'yes';
      } else if (stripped.startsWith('**Prompt:**')) {
        entry.promptToJoel = stripped.replace('**Prompt:**', '').trim();
      } else if (stripped.startsWith('**Status:**')) {
        const statusStr = stripped.replace('**Status:**', '').trim();
        if (statusStr.includes('incomplete')) {
          entry.status = 'incomplete';
        } else if (statusStr.includes('complete')) {
          entry.status = 'complete';
        }
      }
    }
    
    // Calculate status if not explicitly set
    if (entry.heartbeatNum && entry.timestamp) {
      const hasAnswers = entry.qa.some(q => q.answer !== null);
      const isComplete = entry.nextQuestions !== null || !!entry.promptToJoel;
      
      if (hasAnswers && !isComplete) {
        entry.status = 'incomplete';
      } else if (isComplete) {
        entry.status = 'complete';
      }
      
      entries.push(entry);
    }
  }
  
  return entries;
}

// Read and parse
const mdContent = fs.readFileSync(JOURNAL_MD, 'utf8');
const entries = parseJournalMD(mdContent);

console.log(`Parsed ${entries.length} entries`);

// Preview last 3
console.log('\nLast 3 entries:');
entries.slice(-3).forEach(e => {
  console.log(`  #${e.heartbeatNum}: nextQuestions=${JSON.stringify(e.nextQuestions)}, status=${e.status}`);
});

// Write JSON5
const json5Content = JSON5.stringify({ entries }, null, 2);
fs.writeFileSync(JOURNAL_JSON5, json5Content);
console.log(`\nWritten to ${JOURNAL_JSON5}`);

// Backup old journal
const backupPath = JOURNAL_MD + '.bak';
fs.copyFileSync(JOURNAL_MD, backupPath);
console.log(`Backed up to ${backupPath}`);
