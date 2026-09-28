// One-shot: move the additive ALTERs above the CREATE INDEX lines.
// The file has mixed CRLF/LF endings, so match with a regex instead of lines.
const fs = require('fs');
const p = 'server/schema.sql';
const src = fs.readFileSync(p, 'utf8');

const re = /(CREATE INDEX IF NOT EXISTS idx_records_date[\s\S]*?idx_records_status\s+ON records \(status\);\r?\n)\r?\n(ALTER TABLE records ADD COLUMN IF NOT EXISTS color[\s\S]*?ALTER TABLE records ALTER COLUMN quantity DROP NOT NULL;)/;
if (!re.test(src)) {
  console.error('Unexpected layout: pattern not found');
  process.exit(1);
}

const comment = [
  '-- IMPORTANT: additive column fixes MUST stay above the CREATE INDEX lines.',
  '-- On a database whose records table predates color/row_key/signature, the',
  '-- CREATE TABLE IF NOT EXISTS above is a no-op, so the index on',
  '-- (date, material, color) failed with 42703 "column color does not exist",',
  '-- aborting schema init and making every API request return 500.',
  '',
].join('\r\n');

const out = src.replace(re, (_m, idxBlock, altBlock) => comment + altBlock + '\r\n\r\n' + idxBlock);
fs.writeFileSync(p, out);
console.log('reordered OK, delta bytes =', out.length - src.length);

