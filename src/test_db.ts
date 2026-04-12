import { query } from './db.js';

async function test() {
    try {
        const res = await query('SELECT NOW()');
        console.log('Connection successful:', res.rows[0]);
        process.exit(0);
    } catch (err) {
        console.error('Connection failed:', err);
        process.exit(1);
    }
}

test();
