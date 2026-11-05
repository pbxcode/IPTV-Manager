
#!/usr/bin/env node
/**
 * One-time cleanup of stream titles in provider_channels.name
 * Removes common unwanted characters from IPTV provider titles.
 *
 * Usage:
 *   node scripts/clean-stream-titles.mjs
 *   DATA_DIR=/opt/cdn node scripts/clean-stream-titles.mjs
 */

import Database from 'epg.db';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..');
const DB_PATH = path.join(DATA_DIR, 'epg.db');

function cleanStreamTitle(name) {
  if (!name || typeof name !== 'string') return name || '';
  let s = name;

  // Remove control characters and zero-width chars
  s = s.replace(/[\u0000-\u001F\u007F-\u009F\u200B-\u200D\uFEFF]/g, '');

  // Common decorative / junk symbols often seen in IPTV titles
  s = s.replace(/[★☆⬤●♦♥♪♫⚡❖◆■□▲▼►◄✓✔✕✖✗✘☆★●○◐◑◒◓⬤◆◇■□▲▼★☆✦✧✩✪✫✬✭✮✯✰✱✲✳✴✵✶✷✸✹✺✻✼✽✾✿❀❁❂❃❄❅❆❇❈❉❊❋]/g, ' ');

  // Superscript / subscript junk
  s = s.replace(/[ᴬᴮᴰᴱᴳᴴᴵᴶᴷᴸᴹᴺᴼᴾᴿᵀᵁᵂᵃᵇᵈᵉᵍʰⁱʲᵏˡᵐⁿᵒᵖʳˢᵗᵘʷˣʸᶻ⁰¹²³⁴⁵⁶⁷⁸⁹⁺⁻⁼⁽⁾]/g, '');

  // Normalize various dash/quote characters
  s = s.replace(/[‐‑‒–—―]/g, '-');
  s = s.replace(/[‘’‚‛]/g, "'");
  s = s.replace(/[“”„‟]/g, '"');

  // Collapse multiple pipes / separators into a single space or pipe
  s = s.replace(/\s*\|\s*/g, ' | ');
  s = s.replace(/(\s*\|\s*){2,}/g, ' | ');

  // Remove leading/trailing junk separators
  s = s.replace(/^[\s\|\-–—_.:]+/, '');
  s = s.replace(/[\s\|\-–—_.:]+$/, '');

  // Collapse multiple spaces
  s = s.replace(/\s+/g, ' ').trim();

  // If we stripped everything, fall back to original trimmed
  if (!s) return name.trim();
  return s;
}

console.log('Opening database:', DB_PATH);
const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');

console.log('Opening database:', DB_PATH);
const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');

const rows = db.prepare('SELECT id, name FROM provider_channels').all();
console.log(`Found ${rows.length} channels`);

const update = db.prepare('UPDATE provider_channels SET name = ? WHERE id = ?');
let changed = 0;

const tx = db.transaction(() => {
  for (const row of rows) {
    const cleaned = cleanStreamTitle(row.name);
    if (cleaned !== row.name) {
      update.run(cleaned, row.id);
      changed++;
    }
  }
});

tx();
db.close();

console.log(`Updated ${changed} titles`);
console.log('Done. Restart the app or just reload the UI to see the changes.');
