/**
 * Clean common unwanted characters from IPTV stream titles.
 * Conservative: removes decorative junk, control chars, and normalizes separators
 * while keeping the readable channel/movie/series name intact.
 */
export function cleanStreamTitle(name) {
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

  // Collapse multiple pipes / separators
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
