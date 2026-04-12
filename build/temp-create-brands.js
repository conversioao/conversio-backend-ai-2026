import { query } from './db.js';
const sql = `
CREATE TABLE IF NOT EXISTS brands (
    id SERIAL PRIMARY KEY,
    user_id UUID UNIQUE NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    company_name VARCHAR(255),
    logo_url TEXT,
    brand_colors JSONB,
    raw_ai_response JSONB,
    confirmed BOOLEAN DEFAULT FALSE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- Trigger for updated_at
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ language 'plpgsql';

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'update_brands_updated_at') THEN
        CREATE TRIGGER update_brands_updated_at
        BEFORE UPDATE ON brands
        FOR EACH ROW
        EXECUTE FUNCTION update_updated_at_column();
    END IF;
END $$;
`;
async function run() {
    try {
        console.log('[Brands] Creating table...');
        await query(sql);
        console.log('[Brands] Table "brands" created/verified successfully');
        process.exit(0);
    }
    catch (err) {
        console.error('[Brands] Error:', err.message);
        process.exit(1);
    }
}
run();
