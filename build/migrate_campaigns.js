import { query } from './db.js';
async function migrate() {
    try {
        console.log('[CAMPAIGN MIGRATION] Iniciando migração das tabelas de Campanhas...');
        // 1. campaigns
        await query(`
            CREATE TABLE IF NOT EXISTS campaigns (
                id SERIAL PRIMARY KEY,
                name VARCHAR(255) NOT NULL,
                type VARCHAR(50) NOT NULL, -- promotional, educational, reactivation, seasonal
                status VARCHAR(50) DEFAULT 'draft', -- draft, active, paused, completed
                target_segment JSONB DEFAULT '{}',
                message_template TEXT,
                channels JSONB DEFAULT '["whatsapp"]',
                scheduled_at TIMESTAMP,
                started_at TIMESTAMP,
                completed_at TIMESTAMP,
                created_by UUID REFERENCES users(id),
                created_at TIMESTAMP DEFAULT now()
            );
        `);
        console.log('[CAMPAIGN MIGRATION] ✅ Tabela "campaigns" criada');
        // 2. campaign_recipients
        await query(`
            CREATE TABLE IF NOT EXISTS campaign_recipients (
                id SERIAL PRIMARY KEY,
                campaign_id INTEGER REFERENCES campaigns(id) ON DELETE CASCADE,
                user_id UUID REFERENCES users(id) ON DELETE CASCADE,
                status VARCHAR(50) DEFAULT 'pending', -- pending, sent, delivered, opened, clicked, converted
                sent_at TIMESTAMP,
                converted_at TIMESTAMP,
                metadata JSONB DEFAULT '{}',
                UNIQUE(campaign_id, user_id)
            );
        `);
        console.log('[CAMPAIGN MIGRATION] ✅ Tabela "campaign_recipients" criada');
        // 3. campaign_stats
        await query(`
            CREATE TABLE IF NOT EXISTS campaign_stats (
                id SERIAL PRIMARY KEY,
                campaign_id INTEGER NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
                total_sent INTEGER DEFAULT 0,
                total_delivered INTEGER DEFAULT 0,
                total_opened INTEGER DEFAULT 0,
                total_clicked INTEGER DEFAULT 0,
                total_converted INTEGER DEFAULT 0,
                revenue_generated NUMERIC(12,2) DEFAULT 0,
                calculated_at TIMESTAMP DEFAULT now()
            );
        `);
        console.log('[CAMPAIGN MIGRATION] ✅ Tabela "campaign_stats" criada');
        console.log('[CAMPAIGN MIGRATION] ✅ Todas as migrações concluídas com sucesso!');
        process.exit(0);
    }
    catch (error) {
        console.error('[CAMPAIGN MIGRATION] ❌ Falha na migração:', error);
        process.exit(1);
    }
}
migrate();
