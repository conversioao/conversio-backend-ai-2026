import { query } from './db.js';
async function migrate() {
    try {
        console.log('[MONITOR MIGRATION] Iniciando migração das tabelas de Vigilância...');
        // 1. system_metrics
        await query(`
            CREATE TABLE IF NOT EXISTS system_metrics (
                id SERIAL PRIMARY KEY,
                metric_name VARCHAR(100) NOT NULL,
                metric_value NUMERIC(15,2) NOT NULL,
                unit VARCHAR(20),
                recorded_at TIMESTAMP DEFAULT now()
            );
        `);
        console.log('[MONITOR MIGRATION] ✅ Tabela "system_metrics" criada');
        // 2. alerts
        await query(`
            CREATE TABLE IF NOT EXISTS alerts (
                id SERIAL PRIMARY KEY,
                type VARCHAR(50) NOT NULL,
                severity VARCHAR(20) NOT NULL, -- info, warning, critical
                title VARCHAR(255) NOT NULL,
                description TEXT,
                metadata JSONB DEFAULT '{}',
                status VARCHAR(30) DEFAULT 'active', -- active, acknowledged, resolved
                created_at TIMESTAMP DEFAULT now(),
                acknowledged_at TIMESTAMP,
                resolved_at TIMESTAMP
            );
        `);
        console.log('[MONITOR MIGRATION] ✅ Tabela "alerts" criada');
        // 3. alert_rules
        await query(`
            CREATE TABLE IF NOT EXISTS alert_rules (
                id SERIAL PRIMARY KEY,
                metric_name VARCHAR(100) NOT NULL,
                condition VARCHAR(10) NOT NULL, -- gt, lt, eq
                threshold NUMERIC(15,2) NOT NULL,
                severity VARCHAR(20) NOT NULL,
                message_template TEXT NOT NULL,
                cooldown_minutes INTEGER DEFAULT 60,
                last_triggered_at TIMESTAMP,
                is_active BOOLEAN DEFAULT true
            );
        `);
        console.log('[MONITOR MIGRATION] ✅ Tabela "alert_rules" criada');
        // Seed das regras padrão conforme missão
        console.log('[MONITOR MIGRATION] Seeding base alert rules...');
        await query(`
            INSERT INTO alert_rules (metric_name, condition, threshold, severity, message_template, cooldown_minutes) VALUES
            ('agent_stopped', 'gt', 0, 'critical', 'O agente {agent_name} parou de responder!', 120),
            ('agent_error_rate', 'gt', 20, 'warning', 'Taxa de erro elevada no {agent_name}: {value}%', 60),
            ('stuck_tasks', 'gt', 0, 'critical', 'Existem {value} tarefas pendentes há mais de 30 minutos!', 30),
            ('daily_signups', 'eq', 0, 'warning', 'Aqueçam os motores! Zero registos nas últimas 24h.', 1440),
            ('whatsapp_failure_rate', 'gt', 15, 'critical', 'Urgente: Taxa de falha no WhatsApp está em {value}%!', 60)
            ON CONFLICT DO NOTHING;
        `);
        console.log('[MONITOR MIGRATION] ✅ Todas as migrações concluídas com sucesso!');
        process.exit(0);
    }
    catch (error) {
        console.error('[MONITOR MIGRATION] ❌ Falha na migração:', error);
        process.exit(1);
    }
}
migrate();
