import { query } from './db.js';
async function migrate() {
    try {
        console.log('[RECOVERY MIGRATION] Iniciando migração das tabelas de Retenção...');
        // 1. churn_risks
        await query(`
            CREATE TABLE IF NOT EXISTS churn_risks (
                id SERIAL PRIMARY KEY,
                user_id UUID UNIQUE REFERENCES users(id) ON DELETE CASCADE,
                risk_level VARCHAR(20) DEFAULT 'low', -- low, medium, high, critical
                risk_score INTEGER DEFAULT 0, -- 0-100
                last_active_at TIMESTAMP,
                days_inactive INTEGER DEFAULT 0,
                reason JSONB DEFAULT '[]',
                recovery_status VARCHAR(30) DEFAULT 'not_started', -- not_started, in_progress, recovered, churned
                recovery_started_at TIMESTAMP,
                created_at TIMESTAMP DEFAULT now(),
                updated_at TIMESTAMP DEFAULT now()
            );
        `);
        console.log('[RECOVERY MIGRATION] ✅ Tabela "churn_risks" criada');
        // 2. recovery_sequences
        await query(`
            CREATE TABLE IF NOT EXISTS recovery_sequences (
                id SERIAL PRIMARY KEY,
                user_id UUID REFERENCES users(id) ON DELETE CASCADE,
                sequence_step INTEGER DEFAULT 1, -- 1, 2, 3
                message_type VARCHAR(50),
                sent_at TIMESTAMP DEFAULT now(),
                response_received BOOLEAN DEFAULT false,
                converted BOOLEAN DEFAULT false
            );
        `);
        console.log('[RECOVERY MIGRATION] ✅ Tabela "recovery_sequences" criada');
        console.log('[RECOVERY MIGRATION] ✅ Todas as migrações concluídas com sucesso!');
        process.exit(0);
    }
    catch (error) {
        console.error('[RECOVERY MIGRATION] ❌ Falha na migração:', error);
        process.exit(1);
    }
}
migrate();
