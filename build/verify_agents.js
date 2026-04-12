import { query } from './db.js';
async function verify() {
    try {
        console.log('--- VERIFYING PROMPT AGENTS TABLE ---');
        const checkTable = await query("SELECT EXISTS (SELECT FROM information_schema.tables WHERE table_name = 'prompt_agents')");
        console.log('Prompt Agents Table exists:', checkTable.rows[0].exists);
        if (checkTable.rows[0].exists) {
            console.log('--- CHECKING COLUMNS ---');
            const cols = await query("SELECT column_name, data_type FROM information_schema.columns WHERE table_name = 'prompt_agents'");
            cols.rows.forEach(c => console.log(`- ${c.column_name}: ${c.data_type}`));
        }
    }
    catch (err) {
        console.error('Verification failed:', err);
    }
}
verify();
