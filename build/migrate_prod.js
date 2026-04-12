import { Pool } from 'pg';
async function migrate() {
    console.log('[Production Migration] Connecting to Production DB...');
    const pool = new Pool({
        host: process.env.DB_HOST,
        port: parseInt(process.env.DB_PORT || '5432'),
        user: process.env.DB_USER,
        password: process.env.DB_PASSWORD,
        database: process.env.DB_NAME,
        ssl: process.env.DB_SSL === 'true'
    });
    try {
        console.log('[Production Migration] Creating ugc_used_combinations table...');
        await pool.query(`
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
        console.log('[Production Migration] Creating indices and constraints...');
        await pool.query(`
            CREATE INDEX IF NOT EXISTS idx_ugc_user_product ON ugc_used_combinations(user_id, product_hash);
            
            DO $$ 
            BEGIN 
                IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'unique_ugc_combination') THEN
                    ALTER TABLE ugc_used_combinations ADD CONSTRAINT unique_ugc_combination 
                    UNIQUE(user_id, product_hash, tipo_ugc, sub_cena, angulo_camara, emocao_dominante, gancho_tipo, cenario);
                END IF;
            END $$;
        `);
        console.log('[Production Migration] Enabling RLS...');
        await pool.query(`
            ALTER TABLE ugc_used_combinations ENABLE ROW LEVEL SECURITY;
            
            DO $$ 
            BEGIN 
                IF NOT EXISTS (SELECT 1 FROM pg_policy WHERE polname = 'Users can only see their own UGC history') THEN
                    CREATE POLICY "Users can only see their own UGC history" ON ugc_used_combinations
                    FOR SELECT USING (auth.uid() = user_id);
                END IF;
            END $$;
        `);
        console.log('[Production Migration] SUCCESS! Table version created in Production.');
        process.exit(0);
    }
    catch (err) {
        console.error('[Production Migration] Failed:', err);
        process.exit(1);
    }
}
migrate();
