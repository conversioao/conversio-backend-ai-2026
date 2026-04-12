import { query } from './db.js';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
dotenv.config({ path: path.join(__dirname, '../.env') });
async function checkCatalog() {
    try {
        const tables = await query("SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'");
        console.log('Tables:', tables.rows.map((r) => r.table_name));
        const modelsCols = await query("SELECT column_name FROM information_schema.columns WHERE table_name = 'models'");
        console.log('Models Columns:', modelsCols.rows.map((r) => r.column_name));
        const models = await query("SELECT * FROM models LIMIT 10");
        console.table(models.rows);
    }
    catch (err) {
        console.error('Error:', err);
    }
    finally {
        process.exit();
    }
}
checkCatalog();
