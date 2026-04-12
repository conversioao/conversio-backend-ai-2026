import { query } from './db.js';
async function migrateOrchestrator() {
    try {
        console.log('[MIGRATION] Iniciando migração das tabelas do Orquestrador...');
        // 1. Tabela agents
        await query(`
            CREATE TABLE IF NOT EXISTS agents (
                id SERIAL PRIMARY KEY,
                name VARCHAR(100) UNIQUE NOT NULL,
                status VARCHAR(50) DEFAULT 'active', -- active, paused, error
                last_run TIMESTAMP,
                next_run TIMESTAMP,
                config JSONB DEFAULT '{}',
                created_at TIMESTAMP DEFAULT now()
            );
        `);
        console.log('[MIGRATION] ✅ Tabela "agents" pronta.');
        // 2. Tabela agent_tasks
        await query(`
            CREATE TABLE IF NOT EXISTS agent_tasks (
                id SERIAL PRIMARY KEY,
                agent_name VARCHAR(100) REFERENCES agents(name) ON DELETE CASCADE,
                task_type VARCHAR(100) NOT NULL,
                priority INTEGER DEFAULT 3, -- 1: Urgente, 2: Alta, 3: Normal
                payload JSONB DEFAULT '{}',
                status VARCHAR(50) DEFAULT 'pending', -- pending, running, done, failed
                attempts INTEGER DEFAULT 0,
                error_message TEXT,
                created_at TIMESTAMP DEFAULT now(),
                executed_at TIMESTAMP
            );
        `);
        console.log('[MIGRATION] ✅ Tabela "agent_tasks" pronta.');
        // 3. Tabela agent_logs
        await query(`
            CREATE TABLE IF NOT EXISTS agent_logs (
                id SERIAL PRIMARY KEY,
                agent_name VARCHAR(100) REFERENCES agents(name) ON DELETE CASCADE,
                action TEXT NOT NULL,
                user_id UUID,
                result VARCHAR(50), -- success, error
                metadata JSONB DEFAULT '{}',
                created_at TIMESTAMP DEFAULT now()
            );
        `);
        console.log('[MIGRATION] ✅ Tabela "agent_logs" pronta.');
        // 4. Seed initial
        const baseAgents = [
            'Agente Funil',
            'Agente Campanhas',
            'Agente Recuperação',
            'Agente Envios',
            'Agente Monitor'
        ];
        for (const name of baseAgents) {
            await query(`
                INSERT INTO agents (name, status) VALUES ($1, 'active')
                ON CONFLICT (name) DO NOTHING;
            `, [name]);
        }
        console.log('[MIGRATION] ✅ Dados padrão (seed) inseridos em "agents".');
        console.log('[MIGRATION] Orquestrador migrado com sucesso.');
        process.exit(0);
    }
    catch (e) {
        console.error('[MIGRATION ERROR]', e);
        process.exit(1);
    }
}
migrateOrchestrator();
