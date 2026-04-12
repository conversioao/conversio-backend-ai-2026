import { query } from './db.js';

async function migrate() {
    try {
        console.log('[AUTOMATION v3 MIGRATION] Iniciando migração do ecossistema...');

        // 1. Módulo B: Relatórios Automáticos
        console.log('Creating "reports" table...');
        await query(`
            CREATE TABLE IF NOT EXISTS reports (
                id SERIAL PRIMARY KEY,
                type VARCHAR(50) NOT NULL, -- weekly, daily, digest
                period VARCHAR(100), -- 2026-W14, 2026-04-06
                data JSONB NOT NULL,
                generated_at TIMESTAMP DEFAULT now(),
                sent_to VARCHAR(255)
            );
        `);

        // 2. Módulo C: CRM Inteligente
        console.log('Creating "crm_profiles" table...');
        await query(`
            CREATE TABLE IF NOT EXISTS crm_profiles (
                id SERIAL PRIMARY KEY,
                user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE UNIQUE,
                lifetime_value NUMERIC(15,2) DEFAULT 0,
                total_purchases INTEGER DEFAULT 0,
                avg_purchase_value NUMERIC(15,2) DEFAULT 0,
                preferred_channel VARCHAR(30) DEFAULT 'whatsapp',
                best_contact_time VARCHAR(20),
                tags JSONB DEFAULT '[]',
                notes TEXT,
                last_updated TIMESTAMP DEFAULT now()
            );
        `);

        // 3. Módulo D: Retargeting Automático
        console.log('Creating "retargeting_audiences" table...');
        await query(`
            CREATE TABLE IF NOT EXISTS retargeting_audiences (
                id SERIAL PRIMARY KEY,
                name VARCHAR(255) NOT NULL,
                rules JSONB NOT NULL,
                user_ids UUID[] DEFAULT '{}',
                last_synced TIMESTAMP,
                platform VARCHAR(50) DEFAULT 'meta',
                external_audience_id VARCHAR(255),
                created_at TIMESTAMP DEFAULT now()
            );
        `);

        // 4. Configuração Extra para os Agentes (Section 6)
        console.log('Ensure agent_config table exists...');
        await query(`
            CREATE TABLE IF NOT EXISTS agent_config (
                id SERIAL PRIMARY KEY,
                agent_name VARCHAR(100) UNIQUE,
                timing_minutes INTEGER DEFAULT 60,
                allowed_hours JSONB DEFAULT '[8, 22]',
                admin_alert_whatsapp VARCHAR(30),
                recovery_discount_pct INTEGER DEFAULT 15,
                urgency_discount_pct INTEGER DEFAULT 10,
                cooldown_hours INTEGER DEFAULT 24,
                alert_toggles JSONB DEFAULT '{}',
                updated_at TIMESTAMP DEFAULT now()
            );
        `);

        // Seed das configurações padrão se não existirem
        const agents = ['Orquestrador', 'Agente Funil', 'Agente Campanhas', 'Agente Recuperação', 'Agente Envios', 'Agente Monitor'];
        for (const agent of agents) {
            await query(`
                INSERT INTO agent_config (agent_name, timing_minutes)
                VALUES ($1, 60)
                ON CONFLICT (agent_name) DO NOTHING
            `, [agent]);
        }

        console.log('[AUTOMATION v3 MIGRATION] ✅ Migrações concluídas com sucesso!');
        process.exit(0);
    } catch (error) {
        console.error('[AUTOMATION v3 MIGRATION] ❌ Falha na migração:', error);
        process.exit(1);
    }
}

migrate();
