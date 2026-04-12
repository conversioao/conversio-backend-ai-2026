import { query } from './db.js';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
dotenv.config({ path: path.join(__dirname, '../.env') });
async function runRecovery() {
    console.log('--- SYSTEM RECOVERY MIGRATION ---');
    try {
        // 1. Repair agent_logs
        console.log('[1/10] Repairing agent_logs...');
        await query(`
            DO $$ 
            BEGIN 
                IF NOT EXISTS (SELECT FROM information_schema.columns WHERE table_name = 'agent_logs' AND column_name = 'result') THEN
                    ALTER TABLE agent_logs ADD COLUMN result VARCHAR(50) DEFAULT 'success';
                END IF;
                IF NOT EXISTS (SELECT FROM information_schema.columns WHERE table_name = 'agent_logs' AND column_name = 'action') THEN
                    ALTER TABLE agent_logs ADD COLUMN action VARCHAR(100);
                END IF;
                IF NOT EXISTS (SELECT FROM information_schema.columns WHERE table_name = 'agent_logs' AND column_name = 'metadata') THEN
                    ALTER TABLE agent_logs ADD COLUMN metadata JSONB;
                END IF;
            END $$;
        `);
        // 2. Create leads and lead_interactions
        console.log('[2/10] Creating leads and lead_interactions...');
        await query(`
            CREATE TABLE IF NOT EXISTS leads (
                id SERIAL PRIMARY KEY,
                user_id UUID,
                temperature VARCHAR(20) DEFAULT 'cold',
                score INTEGER DEFAULT 0,
                stage VARCHAR(50) DEFAULT 'awareness',
                next_action VARCHAR(100),
                next_action_date TIMESTAMP,
                last_interaction TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
            CREATE TABLE IF NOT EXISTS lead_interactions (
                id SERIAL PRIMARY KEY,
                lead_id INTEGER REFERENCES leads(id),
                type VARCHAR(50),
                metadata JSONB,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
        `);
        // 3. Repair campaigns and related
        console.log('[3/10] Repairing campaigns schema...');
        await query(`
            DO $$ 
            BEGIN 
                IF NOT EXISTS (SELECT FROM information_schema.columns WHERE table_name = 'campaigns' AND column_name = 'target_segment') THEN
                    ALTER TABLE campaigns ADD COLUMN target_segment JSONB;
                END IF;
                IF NOT EXISTS (SELECT FROM information_schema.columns WHERE table_name = 'campaigns' AND column_name = 'message_template') THEN
                    ALTER TABLE campaigns ADD COLUMN message_template TEXT;
                END IF;
                IF NOT EXISTS (SELECT FROM information_schema.columns WHERE table_name = 'campaigns' AND column_name = 'channels') THEN
                    ALTER TABLE campaigns ADD COLUMN channels JSONB;
                END IF;
                IF NOT EXISTS (SELECT FROM information_schema.columns WHERE table_name = 'campaigns' AND column_name = 'created_by') THEN
                    ALTER TABLE campaigns ADD COLUMN created_by UUID;
                END IF;
                IF NOT EXISTS (SELECT FROM information_schema.columns WHERE table_name = 'campaigns' AND column_name = 'completed_at') THEN
                    ALTER TABLE campaigns ADD COLUMN completed_at TIMESTAMP;
                END IF;
            END $$;

            CREATE TABLE IF NOT EXISTS campaign_recipients (
                id SERIAL PRIMARY KEY,
                campaign_id INTEGER REFERENCES campaigns(id),
                user_id UUID,
                status VARCHAR(50) DEFAULT 'pending',
                sent_at TIMESTAMP,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                UNIQUE(campaign_id, user_id)
            );

            CREATE TABLE IF NOT EXISTS campaign_stats (
                id SERIAL PRIMARY KEY,
                campaign_id INTEGER REFERENCES campaigns(id),
                total_sent INTEGER DEFAULT 0,
                total_converted INTEGER DEFAULT 0,
                calculated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
        `);
        // 4. Infrastructure (Tasks, Logs, Metrics)
        console.log('[4/10] Creating infrastructure tables...');
        await query(`
            CREATE TABLE IF NOT EXISTS agent_tasks (
                id SERIAL PRIMARY KEY,
                agent_name VARCHAR(100),
                task_type VARCHAR(100),
                priority INTEGER DEFAULT 2,
                payload JSONB,
                status VARCHAR(50) DEFAULT 'pending',
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );

            CREATE TABLE IF NOT EXISTS whatsapp_logs (
                id SERIAL PRIMARY KEY,
                recipient VARCHAR(50),
                message TEXT,
                status VARCHAR(50),
                type VARCHAR(50),
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );

            CREATE TABLE IF NOT EXISTS system_metrics (
                id SERIAL PRIMARY KEY,
                metric_name VARCHAR(100),
                metric_value NUMERIC,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );

            CREATE TABLE IF NOT EXISTS alert_rules (
                id SERIAL PRIMARY KEY,
                metric_name VARCHAR(100),
                condition VARCHAR(20),
                threshold NUMERIC,
                severity VARCHAR(20),
                message_template TEXT,
                is_active BOOLEAN DEFAULT true,
                cooldown_minutes INTEGER DEFAULT 60,
                last_triggered_at TIMESTAMP
            );

            CREATE TABLE IF NOT EXISTS alerts (
                id SERIAL PRIMARY KEY,
                type VARCHAR(50),
                severity VARCHAR(20),
                title TEXT,
                description TEXT,
                metadata JSONB,
                status VARCHAR(20) DEFAULT 'open',
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
        `);
        // 5. Team and Health
        console.log('[5/10] Creating agent team health tables...');
        await query(`
            CREATE TABLE IF NOT EXISTS agents (
                id SERIAL PRIMARY KEY,
                name VARCHAR(100) UNIQUE,
                last_run TIMESTAMP,
                status VARCHAR(20) DEFAULT 'active'
            );

            CREATE TABLE IF NOT EXISTS agent_team (
                id SERIAL PRIMARY KEY,
                name VARCHAR(100),
                persona_name VARCHAR(100),
                emoji VARCHAR(10),
                trigger_type VARCHAR(50),
                delay_days INTEGER DEFAULT 0,
                delay_hours INTEGER DEFAULT 0,
                mission TEXT,
                message_template TEXT,
                requires_approval BOOLEAN DEFAULT false,
                approval_action_type VARCHAR(50),
                approval_action_value JSONB,
                is_active BOOLEAN DEFAULT true,
                order_index INTEGER DEFAULT 0,
                sent_count INTEGER DEFAULT 0
            );

            CREATE TABLE IF NOT EXISTS agent_executions (
                id SERIAL PRIMARY KEY,
                user_id UUID,
                agent_id INTEGER,
                status VARCHAR(50),
                message_sent TEXT,
                whatsapp_sent BOOLEAN DEFAULT false,
                scheduled_at TIMESTAMP,
                executed_at TIMESTAMP,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                UNIQUE(user_id, agent_id)
            );

            CREATE TABLE IF NOT EXISTS agent_approvals (
                id SERIAL PRIMARY KEY,
                execution_id INTEGER REFERENCES agent_executions(id),
                user_id UUID,
                agent_id INTEGER,
                type VARCHAR(50),
                details JSONB,
                status VARCHAR(50) DEFAULT 'pending',
                admin_notes TEXT,
                resolved_at TIMESTAMP,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
        `);
        // 6. Legacy Stubs (to prevent crashes)
        console.log('[6/10] Creating legacy stubs (plans, subscriptions)...');
        await query(`
            CREATE TABLE IF NOT EXISTS plans (
                id SERIAL PRIMARY KEY,
                name VARCHAR(100),
                price_id VARCHAR(100),
                credits_per_month INTEGER,
                is_active BOOLEAN DEFAULT true
            );
            CREATE TABLE IF NOT EXISTS user_subscriptions (
                id SERIAL PRIMARY KEY,
                user_id UUID,
                plan_id TEXT,
                status VARCHAR(50),
                current_period_end TIMESTAMP,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
        `);
        // 7. Cleanup users.plan (Force removal if still exists)
        console.log('[7/10] Cleanup users table structure...');
        await query(`
            DO $$ 
            BEGIN 
                IF EXISTS (SELECT FROM information_schema.columns WHERE table_name = 'users' AND column_name = 'plan') THEN
                    ALTER TABLE users DROP COLUMN plan;
                END IF;
            END $$;
        `);
        // 8. Seed baseline data if empty
        console.log('[8/10] Seeding baseline config...');
        const agentCount = await query('SELECT COUNT(*) FROM agent_team');
        if (parseInt(agentCount.rows[0].count) === 0) {
            await query(`
                INSERT INTO agent_team (name, persona_name, emoji, trigger_type, delay_days, mission, message_template, order_index)
                VALUES 
                ('Agente Boas-vindas', 'Alex', '👋', 'days_after_signup', 0, 'Dar as boas-vindas e orientar no primeiro uso.', 'Olá {name}! Sou o Alex. Vi que te registaste agora na Conversio. Como posso ajudar-te a criar o teu primeiro anúncio hoje?', 0),
                ('Agente Retenção', 'Sofia', '🤝', 'days_after_signup', 3, 'Garantir que o utilizador volta e vê valor.', 'Olá {name}, a Sofia aqui! Notei que ainda tens {credits} créditos. Que tal usarmos um para destacar o teu produto esta tarde?', 1)
            `);
        }
        console.log('--- RECOVERY COMPLETE ---');
    }
    catch (err) {
        console.error('--- RECOVERY FAILED ---');
        console.error(err);
    }
    finally {
        process.exit();
    }
}
runRecovery();
