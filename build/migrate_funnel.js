import { query } from './db.js';
async function migrateFunnel() {
    try {
        console.log('[MIGRATION] Iniciando migração das tabelas de Lead Scoring & Pipeline...');
        // 1. Tabela: leads
        await query(`
            CREATE TABLE IF NOT EXISTS leads (
                id SERIAL PRIMARY KEY,
                user_id UUID UNIQUE REFERENCES users(id) ON DELETE CASCADE,
                score INTEGER DEFAULT 0, -- 0-100
                temperature VARCHAR(20) DEFAULT 'cold', -- cold, warm, hot
                stage VARCHAR(30) DEFAULT 'awareness', -- awareness, interest, decision, action
                last_interaction TIMESTAMP,
                next_action VARCHAR(255),
                next_action_date TIMESTAMP,
                notes TEXT,
                created_at TIMESTAMP DEFAULT now()
            );
        `);
        console.log('[MIGRATION] ✅ Tabela "leads" criada com sucesso.');
        // 2. Tabela: lead_interactions
        await query(`
            CREATE TABLE IF NOT EXISTS lead_interactions (
                id SERIAL PRIMARY KEY,
                lead_id INTEGER REFERENCES leads(id) ON DELETE CASCADE,
                type VARCHAR(50) NOT NULL, -- message_sent, email_opened, link_clicked, feature_used, upgrade_viewed
                metadata JSONB DEFAULT '{}',
                created_at TIMESTAMP DEFAULT now()
            );
        `);
        console.log('[MIGRATION] ✅ Tabela "lead_interactions" criada com sucesso.');
        // 3. Preparação: Inserir todos utilizadores atuais na tabela leads
        // Útil para quando ativarmos o código já existam alvos na base de dados
        await query(`
            INSERT INTO leads (user_id)
            SELECT id FROM users
            ON CONFLICT (user_id) DO NOTHING;
        `);
        console.log('[MIGRATION] ✅ Registos inaugurais importados com de Tabela Users para Leads.');
        console.log('[MIGRATION] Processo de migração de Sales Funnel terminado.');
        process.exit(0);
    }
    catch (e) {
        console.error('[MIGRATION ERROR]', e);
        process.exit(1);
    }
}
migrateFunnel();
