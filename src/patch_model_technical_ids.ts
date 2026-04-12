import { query } from './db.js';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

dotenv.config({ path: path.join(__dirname, '../.env') });

async function patchModelIds() {
    console.log('--- PATCHING MODEL TECHNICAL IDs (KIE AI) ---');
    try {
        const updates = [
            { id: 120, technicalId: 'google/nano-banana-edit' },    // Nano Banana Lite
            { id: 121, technicalId: 'nano-banana-pro' },            // Nano Banana Pro
            { id: 122, technicalId: 'nano-banana-2' },              // Nano Banana 2
            { id: 123, technicalId: 'seedream/5-lite-text-to-image' }, // Seedream 5.0
            { id: 124, technicalId: 'seedream/4.5-edit' },           // Seedream 4.5
            { id: 125, technicalId: 'ideogram/v3' }                 // Ideogram V3 (Fallback guess)
        ];

        for (const up of updates) {
            await query('UPDATE models SET style_id = $1 WHERE id = $2', [up.technicalId, up.id]);
        }

        console.log('✅ Models updated with technical IDs.');

        // Re-check
        const res = await query('SELECT id, name, style_id FROM models WHERE category = \'model\' ORDER BY sort_order');
        console.table(res.rows);

    } catch (err) {
        console.error('❌ Failed to patch models:', err);
    } finally {
        process.exit();
    }
}

patchModelIds();
