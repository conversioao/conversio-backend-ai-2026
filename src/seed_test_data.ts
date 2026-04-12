import { query } from './db.js';

async function seedFullSystem() {
    console.log('🚀 Iniciando seeding PROFUNDO do sistema...');

    try {
        // 1. Limpar dados de teste anteriores
        console.log('--- Cleaning old test data ---');
        await query("DELETE FROM users WHERE email LIKE '%test.conversio.ai'");
        await query("DELETE FROM whatsapp_leads WHERE phone LIKE '244999%'");

        // 2. Criar Utilizadores em diferentes estágios
        console.log('--- Seeding Users for Agents ---');
        
        // Sofia (Welcome - Day 0)
        const userSofia = await query(
            `INSERT INTO users (id, name, email, whatsapp, role, created_at, password_hash) 
             VALUES (gen_random_uuid(), $1, $2, $3, $4, NOW(), 'dummy_hash') RETURNING id`,
            ['Sofia Teste', 'sofia@test.conversio.ai', '244999000001', 'user']
        );

        // Marco (Retention - Day 3)
        const userMarco = await query(
            `INSERT INTO users (id, name, email, whatsapp, role, created_at, password_hash) 
             VALUES (gen_random_uuid(), $1, $2, $3, $4, NOW() - INTERVAL '3 days', 'dummy_hash') RETURNING id`,
            ['Marco Teste', 'marco@test.conversio.ai', '244999000002', 'user']
        );

        // Risk (Churn - Day 10)
        const userRisk = await query(
            `INSERT INTO users (id, name, email, whatsapp, role, created_at, password_hash) 
             VALUES (gen_random_uuid(), $1, $2, $3, $4, NOW() - INTERVAL '10 days', 'dummy_hash') RETURNING id`,
            ['Risk Teste', 'risk@test.conversio.ai', '244999000003', 'user']
        );

        const allUserIds = [userSofia.rows[0].id, userMarco.rows[0].id, userRisk.rows[0].id];

        // 3. Criar Gerações (Para o gráfico de atividade)
        console.log('--- Seeding 50+ Generations ---');
        for (let i = 0; i < 60; i++) {
            const userId = allUserIds[Math.floor(Math.random() * allUserIds.length)];
            const daysAgo = Math.floor(Math.random() * 7);
            const type = Math.random() > 0.5 ? 'image' : 'video';
            await query(
                `INSERT INTO generations (user_id, type, model, status, created_at, prompt) 
                 VALUES ($1, $2, $3, $4, NOW() - INTERVAL '${daysAgo} days', $5)`,
                [userId, type, type === 'image' ? 'nano_pro' : 'kling', 'completed', 'Test prompt for ' + type]
            );
        }

        // 4. Criar Transações (Para o gráfico de faturação)
        console.log('--- Seeding 10+ Transactions ---');
        const amounts = [2500, 5000, 10000, 25000];
        for (let i = 0; i < 15; i++) {
            const userId = allUserIds[Math.floor(Math.random() * allUserIds.length)];
            const daysAgo = Math.floor(Math.random() * 30);
            const amount = amounts[Math.floor(Math.random() * amounts.length)];
            await query(
                `INSERT INTO transactions (user_id, amount, currency, status, type, description, credits, payment_method, created_at) 
                 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW() - INTERVAL '${daysAgo} days')`,
                [userId, amount, 'Kz', 'completed', 'credit_purchase', 'Recarga de Créditos via Seeding', amount/100, 'Multicaixa Express']
            );
        }

        // 5. CRM Interactions
        console.log('--- Seeding CRM Interactions ---');
        for (const userId of allUserIds) {
            await query(
                `INSERT INTO crm_interactions (user_id, type, content) VALUES 
                 ($1, 'signup', 'Utilizador registou-se via Landing Page.'),
                 ($1, 'conversion_hint', 'Visualizou a página de preços 2 vezes.')`,
                [userId]
            );
        }

        // 6. WhatsApp Leads (Success cases)
        console.log('--- Seeding WhatsApp Leads ---');
        await query(
            `INSERT INTO whatsapp_leads (phone, name, business_info, needs, status, agent_active, last_interaction) 
             VALUES 
             ('244999888777', 'Artur Empreendedor', 'Carpintaria Artur', 'Anúncios para Facebook', 'converted', false, NOW() - INTERVAL '1 day'),
             ('244999666555', 'Bela Consultoria', 'Bela Estética', 'Gestão de Instagram', 'qualified', true, NOW())
             ON CONFLICT (phone) DO NOTHING`
        );

        // 7. System Metrics Final Update
        await query("UPDATE system_metrics SET value = 85 WHERE metric_name = 'active_conversations'");
        await query("UPDATE system_metrics SET value = 24 WHERE metric_name = 'leads_today'");

        console.log('✅ SEEDING PROFUNDO CONCLUÍDO!');
        console.log('Utilizadores criados para testar Sofia (D-0), Marco (D-3) e Risk (D-10).');
    } catch (error) {
        console.error('❌ Erro no seeding profundo:', error);
    } finally {
        process.exit();
    }
}

seedFullSystem();
