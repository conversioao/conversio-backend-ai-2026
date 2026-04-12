import { query } from './db.js';

async function migrate() {
    try {
        console.log('Starting migrations...');

        // 1. Update users table
        console.log('Updating users table...');
        await query(`
            ALTER TABLE users 
            ADD COLUMN IF NOT EXISTS whatsapp_verified BOOLEAN DEFAULT false,
            ADD COLUMN IF NOT EXISTS whatsapp_verification_code VARCHAR(10),
            ADD COLUMN IF NOT EXISTS whatsapp_verification_expires TIMESTAMP,
            ADD COLUMN IF NOT EXISTS crm_stage_id INTEGER,
            ADD COLUMN IF NOT EXISTS last_active_at TIMESTAMP DEFAULT now(),
            ADD COLUMN IF NOT EXISTS last_login_at TIMESTAMP;
        `);

        // 2. Create crm_stages table
        console.log('Creating crm_stages table...');
        await query(`
            CREATE TABLE IF NOT EXISTS crm_stages (
                id SERIAL PRIMARY KEY,
                name VARCHAR(100) NOT NULL,
                order_index INTEGER NOT NULL,
                color VARCHAR(20) DEFAULT '#3b82f6'
            );
        `);

        // Insert default stages if they don't exist
        const stagesCount = await query('SELECT count(*) FROM crm_stages');
        if (parseInt(stagesCount.rows[0].count) === 0) {
            console.log('Inserting default CRM stages...');
            await query(`
                INSERT INTO crm_stages (name, order_index, color) VALUES
                ('Lead', 0, '#94a3b8'),
                ('Contato feito', 1, '#3b82f6'),
                ('Proposta enviada', 2, '#f59e0b'),
                ('Convertido', 3, '#10b981'),
                ('Perdido', 4, '#ef4444');
            `);
        }

        // 3. Create crm_follow_up_sequences table
        console.log('Creating crm_follow_up_sequences table...');
        await query(`
            CREATE TABLE IF NOT EXISTS crm_follow_up_sequences (
                id SERIAL PRIMARY KEY,
                trigger_type VARCHAR(50) NOT NULL, -- idle_days, stage_change, low_usage
                delay_days INTEGER DEFAULT 0,
                message_template TEXT NOT NULL,
                is_active BOOLEAN DEFAULT true,
                created_at TIMESTAMP DEFAULT now()
            );
        `);

        // 4. Create crm_campaigns table
        console.log('Creating crm_campaigns table...');
        await query(`
            CREATE TABLE IF NOT EXISTS crm_campaigns (
                id SERIAL PRIMARY KEY,
                name VARCHAR(255) NOT NULL,
                segmentation_filters JSONB DEFAULT '{}',
                message_template TEXT NOT NULL,
                scheduled_at TIMESTAMP,
                status VARCHAR(50) DEFAULT 'draft', -- draft, scheduled, completed
                created_at TIMESTAMP DEFAULT now()
            );
        `);

        // 5. Create crm_interactions table
        console.log('Creating crm_interactions table...');
        await query(`
            CREATE TABLE IF NOT EXISTS crm_interactions (
                id SERIAL PRIMARY KEY,
                user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                type VARCHAR(50) NOT NULL, -- whatsapp_sent, stage_move, note
                content TEXT,
                created_at TIMESTAMP DEFAULT now()
            );
        `);

        console.log('Migrations completed successfully!');
        process.exit(0);
    } catch (error) {
        console.error('Migration failed:', error);
        process.exit(1);
    }
}

migrate();
