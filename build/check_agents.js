import { query } from './db.js';
async function check() {
    try {
        const result = await query('SELECT category, count(*) FROM prompt_agents GROUP BY category');
        console.log('--- Agent Counts by Category ---');
        result.rows.forEach(row => {
            console.log(`${row.category}: ${row.count}`);
        });
        const all = await query('SELECT id, technical_id, name, category FROM prompt_agents');
        console.log('\n--- All Agents ---');
        all.rows.forEach(row => {
            console.log(`[${row.id}] ${row.technical_id || 'no-id'} - ${row.name} (${row.category})`);
        });
    }
    catch (err) {
        console.error('Error:', err);
    }
    finally {
        process.exit();
    }
}
check();
