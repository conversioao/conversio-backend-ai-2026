import { query } from './db.js';
import fs from 'fs';
async function check() {
    try {
        const res = await query("SELECT column_name, is_nullable, column_default FROM information_schema.columns WHERE table_name = 'plans'");
        fs.writeFileSync('plans_columns.json', JSON.stringify(res.rows, null, 2));
        console.log('Columns saved.');
    }
    catch (err) {
        console.error(err);
    }
    process.exit(0);
}
check();
