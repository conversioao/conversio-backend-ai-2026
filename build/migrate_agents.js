import { query } from './db.js';
async function migrate() {
    try {
        console.log('[AGENT MIGRATION] Starting agent system migrations...');
        // 1. agent_team — configuração de cada agente
        await query(`
            CREATE TABLE IF NOT EXISTS agent_team (
                id SERIAL PRIMARY KEY,
                name VARCHAR(100) NOT NULL,
                persona_name VARCHAR(100) NOT NULL DEFAULT 'Assistente',
                emoji VARCHAR(10) DEFAULT '🤖',
                trigger_type VARCHAR(50) NOT NULL,
                delay_days INTEGER DEFAULT 0,
                delay_hours INTEGER DEFAULT 0,
                mission TEXT NOT NULL,
                message_template TEXT NOT NULL,
                requires_approval BOOLEAN DEFAULT false,
                approval_action_type VARCHAR(50),
                approval_action_value JSONB DEFAULT '{}',
                is_active BOOLEAN DEFAULT true,
                order_index INTEGER DEFAULT 0,
                sent_count INTEGER DEFAULT 0,
                created_at TIMESTAMP DEFAULT now()
            );
        `);
        console.log('[AGENT MIGRATION] ✅ agent_team created');
        // 2. agent_executions — log de cada agente por utilizador
        await query(`
            CREATE TABLE IF NOT EXISTS agent_executions (
                id SERIAL PRIMARY KEY,
                user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                agent_id INTEGER NOT NULL REFERENCES agent_team(id) ON DELETE CASCADE,
                status VARCHAR(50) DEFAULT 'pending',
                message_sent TEXT,
                whatsapp_sent BOOLEAN DEFAULT false,
                scheduled_at TIMESTAMP,
                executed_at TIMESTAMP,
                created_at TIMESTAMP DEFAULT now(),
                UNIQUE(user_id, agent_id)
            );
        `);
        console.log('[AGENT MIGRATION] ✅ agent_executions created');
        // 3. agent_approvals — aprovações admin pendentes
        await query(`
            CREATE TABLE IF NOT EXISTS agent_approvals (
                id SERIAL PRIMARY KEY,
                execution_id INTEGER REFERENCES agent_executions(id) ON DELETE CASCADE,
                user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                agent_id INTEGER NOT NULL REFERENCES agent_team(id),
                type VARCHAR(50) NOT NULL,
                details JSONB DEFAULT '{}',
                status VARCHAR(30) DEFAULT 'pending',
                admin_notes TEXT,
                created_at TIMESTAMP DEFAULT now(),
                resolved_at TIMESTAMP
            );
        `);
        console.log('[AGENT MIGRATION] ✅ agent_approvals created');
        // 4. admin_notifications — feed de notificações em tempo real
        await query(`
            CREATE TABLE IF NOT EXISTS admin_notifications (
                id SERIAL PRIMARY KEY,
                type VARCHAR(50) NOT NULL,
                title VARCHAR(255) NOT NULL,
                message TEXT NOT NULL,
                icon VARCHAR(10) DEFAULT '🔔',
                color VARCHAR(30) DEFAULT 'blue',
                reference_id VARCHAR(100),
                reference_type VARCHAR(50),
                is_read BOOLEAN DEFAULT false,
                created_at TIMESTAMP DEFAULT now()
            );
        `);
        console.log('[AGENT MIGRATION] ✅ admin_notifications created');
        // 5. user_invoices — faturas do utilizador
        await query(`
            CREATE TABLE IF NOT EXISTS user_invoices (
                id SERIAL PRIMARY KEY,
                user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                transaction_id INTEGER,
                invoice_number VARCHAR(50) UNIQUE NOT NULL,
                plan_name VARCHAR(100),
                amount NUMERIC(10,2) NOT NULL,
                currency VARCHAR(10) DEFAULT 'AOA',
                status VARCHAR(30) DEFAULT 'paid',
                invoice_url TEXT,
                payment_method VARCHAR(50),
                issued_at TIMESTAMP DEFAULT now(),
                created_at TIMESTAMP DEFAULT now()
            );
        `);
        console.log('[AGENT MIGRATION] ✅ user_invoices created');
        // 6. Seed dos 5 agentes padrão (só se a tabela estiver vazia)
        const existingAgents = await query('SELECT COUNT(*) FROM agent_team');
        if (parseInt(existingAgents.rows[0].count) === 0) {
            console.log('[AGENT MIGRATION] Seeding default agents...');
            await query(`
                INSERT INTO agent_team (name, persona_name, emoji, trigger_type, delay_days, delay_hours, mission, message_template, requires_approval, order_index) VALUES
                (
                    'Agente de Boas-Vindas',
                    'Sofia',
                    '👋',
                    'days_after_signup',
                    0, 0,
                    'Dar as boas-vindas ao novo utilizador, apresentar a plataforma e criar um primeiro ponto de contacto quente e humano.',
                    E'Olá {name}! 👋 Seja bem-vindo(a) à *Conversio AI*!\\n\\nSou a Sofia, a tua assistente pessoal aqui na plataforma. 🚀\\n\\nA Conversio foi criada para te ajudar a criar conteúdo publicitário incrível com IA — anúncios, imagens e vídeos que convertem.\\n\\nJá tens *500 créditos* na tua conta para explorares. Experimenta agora mesmo e diz-me o que achaste! 😊',
                    false,
                    1
                ),
                (
                    'Agente de Ativação',
                    'Marco',
                    '⚡',
                    'days_after_signup',
                    1, 0,
                    'Verificar se o utilizador já usou a plataforma e encorajá-lo a fazer a primeira geração de conteúdo.',
                    E'Olá {name}! Aqui é o Marco da Conversio. ⚡\\n\\nNotei que ainda não geraste o teu primeiro anúncio. Que tal experimentar agora?\\n\\n👉 Vai a conversio.ai, carrega numa geração e vê a magia acontecer em segundos.\\n\\nOs nossos utilizadores ficam sempre impressionados na primeira vez! Tens dúvidas? Responde aqui mesmo que eu ajudo. 😎',
                    false,
                    2
                ),
                (
                    'Agente de Conversão',
                    'Ana',
                    '💎',
                    'days_after_signup',
                    3, 0,
                    'Apresentar os planos pagos de forma persuasiva, destacando o valor e o ROI para o negócio do utilizador.',
                    E'Olá {name}! Aqui é a Ana da Conversio. 💎\\n\\nJá levaste 3 dias a explorar a nossa plataforma — espero que esteja a gostar!\\n\\nSe quiseres desbloquear tudo — vídeos ilimitados, modelos premium e prioridade nas gerações — os nossos planos PRO começam em apenas *5.000 AOA/mês*.\\n\\n💡 Investes menos que um café por dia e poupas horas de trabalho criativo.\\n\\nQuer saber mais sobre os planos? Responde aqui! 🚀',
                    false,
                    3
                ),
                (
                    'Agente de Urgência',
                    'Ricardo',
                    '🔥',
                    'free_plan_day_5',
                    5, 0,
                    'Criar urgência com uma oferta por tempo limitado para utilizadores que ainda estão no plano gratuito ao fim de 5 dias.',
                    E'Olá {name}! 🔥 Aqui é o Ricardo.\\n\\nEstás há 5 dias connosco e ainda não fizeste upgrade. Percebo — às vezes há dúvidas!\\n\\nPor isso tenho uma proposta especial *válida apenas por 48 horas*: upgrade para o plano Pro com condições exclusivas!\\n\\n👉 Acede agora: conversio.ai/planos\\n\\nSe tiveres alguma dúvida sobre qual plano é ideal para o teu negócio, diz-me e analiso contigo. ⏳',
                    true,
                    4
                ),
                (
                    'Agente de Retenção',
                    'Lara',
                    '🤝',
                    'free_plan_day_10',
                    10, 0,
                    'Última tentativa de conversão. Mensagem muito personalizada, com empatia e oferta final. Alerta o admin se falhar.',
                    E'Olá {name}, aqui é a Lara. 🤝\\n\\nJá passaram 10 dias desde que te juntaste à Conversio AI e quero ter certeza de que estás a ter uma boa experiência.\\n\\nSe houver algo que não está a funcionar bem, ou se precisas de ajuda para começar, estou aqui — basta responder a esta mensagem.\\n\\nE se precisares de um plano especial adaptado ao teu orçamento, diz-me — podemos ver o que é possível fazer por ti. 💙',
                    true,
                    5
                );
            `);
            console.log('[AGENT MIGRATION] ✅ Default agents seeded');
        }
        // 7. Adicionar coluna admin_whatsapp nas config se não existir
        await query(`
            INSERT INTO system_config (key, value, description) 
            VALUES ('admin_whatsapp', '', 'Número WhatsApp do admin para notificações de pagamento')
            ON CONFLICT (key) DO NOTHING;
        `).catch(() => {
            console.log('[AGENT MIGRATION] system_config insert skipped (table may not exist yet)');
        });
        console.log('[AGENT MIGRATION] ✅ All migrations completed successfully!');
        process.exit(0);
    }
    catch (error) {
        console.error('[AGENT MIGRATION] ❌ Migration failed:', error);
        process.exit(1);
    }
}
migrate();
