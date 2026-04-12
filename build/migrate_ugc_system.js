import { query } from './db.js';
// SEC-05: Migration for UGC Anti-Repetition System
async function migrate() {
    try {
        console.log('[Migration] Creating ugc_used_combinations table...');
        await query(`
            CREATE TABLE IF NOT EXISTS ugc_used_combinations (
                id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
                user_id UUID REFERENCES users(id) ON DELETE CASCADE,
                product_hash VARCHAR(64) NOT NULL,
                tipo_ugc VARCHAR(50) NOT NULL,
                sub_cena VARCHAR(100) NOT NULL,
                angulo_camara VARCHAR(50) NOT NULL,
                emocao_dominante VARCHAR(50) NOT NULL,
                gancho_tipo VARCHAR(50) NOT NULL,
                cenario VARCHAR(100) NOT NULL,
                created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
            );
        `);
        // Create Indices
        console.log('[Migration] Creating indexes (idx_ugc_user_product, idx_ugc_combination)...');
        await query('CREATE INDEX IF NOT EXISTS idx_ugc_user_product ON ugc_used_combinations (user_id, product_hash);');
        await query('CREATE INDEX IF NOT EXISTS idx_ugc_combination ON ugc_used_combinations (tipo_ugc, sub_cena);');
        // Add Unique Constraint for ON CONFLICT DO NOTHING
        console.log('[Migration] Adding unique constraint for duplication prevention...');
        await query(`
            ALTER TABLE ugc_used_combinations 
            ADD CONSTRAINT unique_ugc_combination 
            UNIQUE (user_id, product_hash, tipo_ugc, sub_cena, angulo_camara, emocao_dominante, gancho_tipo, cenario)
        `).catch(e => console.log('[Migration] Unique constraint might already exist.'));
        // Enable RLS (Note: Application level security will also be enforced in api.ts)
        console.log('[Migration] Enabling RLS...');
        await query('ALTER TABLE ugc_used_combinations ENABLE ROW LEVEL SECURITY;');
        // Add Basic Policy (If using PostgREST/Supabase compatible session variables)
        await query(`
            DO $$ 
            BEGIN 
                IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'user_access_policy' AND tablename = 'ugc_used_combinations') THEN
                    CREATE POLICY user_access_policy ON ugc_used_combinations 
                    FOR ALL
                    USING (user_id::text = current_setting('app.user_id', true));
                END IF;
            END $$;
        `);
        console.log('[Migration] Table and indices created successfully.');
        process.exit(0);
    }
    catch (err) {
        console.error('[Migration] Failed:', err);
        process.exit(1);
    }
}
migrate();
