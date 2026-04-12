import { query } from './db.js';
// SEC-04: Migration to create refresh_tokens table
async function migrate() {
    try {
        console.log('[Migration] Creating refresh_tokens table...');
        // Ensure pgcrypto is available for gen_random_uuid() if on older Postgres
        // but gen_random_uuid is built-in for PG 13+
        await query('CREATE EXTENSION IF NOT EXISTS "pgcrypto";');
        await query(`
            CREATE TABLE IF NOT EXISTS refresh_tokens (
                id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
                user_id UUID REFERENCES users(id) ON DELETE CASCADE,
                token_hash VARCHAR(255) NOT NULL,
                expires_at TIMESTAMP NOT NULL,
                revoked BOOLEAN DEFAULT FALSE,
                created_at TIMESTAMP DEFAULT NOW()
            );
        `);
        console.log('[Migration] Table created successfully.');
        process.exit(0);
    }
    catch (err) {
        console.error('[Migration] Failed:', err);
        process.exit(1);
    }
}
migrate();
