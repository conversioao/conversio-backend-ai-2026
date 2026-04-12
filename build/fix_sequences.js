import * as fs from 'fs';
import * as path from 'path';
const filePath = path.join(process.cwd(), '../backup_conversio_ao_2026-03-27T09-43-13_fixed.sql');
const targetPath = path.join(process.cwd(), '../backup_conversio_ao_2026-03-27T09-43-13_final.sql');
if (!fs.existsSync(filePath)) {
    console.error('File not found:', filePath);
    process.exit(1);
}
const sql = fs.readFileSync(filePath, 'utf8');
const seqs = new Set();
const regex = /nextval\('([^']+)'/g;
let match;
while ((match = regex.exec(sql)) !== null) {
    seqs.add(match[1]);
}
console.log('Found sequences:', Array.from(seqs));
let header = '-- =====================================================\n';
header += '-- MISSING SEQUENCES FIX\n';
header += '-- =====================================================\n\n';
for (const seq of seqs) {
    header += `CREATE SEQUENCE IF NOT EXISTS "${seq}";\n`;
}
header += '\n';
fs.writeFileSync(targetPath, header + sql, 'utf8');
console.log('Final SQL file created:', targetPath);
