import { query } from './db.js';

async function migrate() {
    try {
        console.log('[LEAD MIGRATION] Iniciando migração do sistema de Leads WhatsApp...');

        // 1. whatsapp_leads — leads que chegam via WhatsApp (antes de registo formal)
        await query(`
            CREATE TABLE IF NOT EXISTS whatsapp_leads (
                id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
                phone VARCHAR(20) UNIQUE NOT NULL,
                name VARCHAR(100),
                business_info TEXT,
                needs TEXT,
                budget VARCHAR(100),
                status VARCHAR(50) DEFAULT 'new', -- new, in_progress, qualified, converted, human
                agent_active BOOLEAN DEFAULT true,
                last_interaction TIMESTAMP DEFAULT now(),
                created_at TIMESTAMP DEFAULT now()
            );
        `);
        console.log('[LEAD MIGRATION] ✅ Tabela "whatsapp_leads" pronta.');

        // 2. whatsapp_messages — histórico de conversas (contexto para a IA)
        await query(`
            CREATE TABLE IF NOT EXISTS whatsapp_messages (
                id SERIAL PRIMARY KEY,
                lead_id UUID REFERENCES whatsapp_leads(id) ON DELETE CASCADE,
                role VARCHAR(20) NOT NULL, -- user, agent, human
                content TEXT NOT NULL,
                created_at TIMESTAMP DEFAULT now()
            );
        `);
        console.log('[LEAD MIGRATION] ✅ Tabela "whatsapp_messages" pronta.');

        // 3. Adicionar coluna context_briefing na tabela users para comunicação entre agentes
        await query(`
            ALTER TABLE users ADD COLUMN IF NOT EXISTS context_briefing TEXT;
        `).catch(() => console.log('[LEAD MIGRATION] Coluna context_briefing já existe em "users".'));

        // 4. Configurações Globais do Agente
        await query(`
            INSERT INTO system_settings (key, value, description) VALUES 
            ('whatsapp_agent_enabled', 'true', 'Ativar/Desativar Agente WhatsApp de Qualificação'),
            ('whatsapp_agent_prompt', 'Você é um assistente da Conversio AI, focado em qualificar leads de anúncios no WhatsApp. O seu tom de voz é de Angola (informal-profissional). O seu objetivo é extrair: Nome, Negócio e Necessidade do lead antes de passá-lo ao funil principal.', 'System Prompt do Agente de Qualificação')
            ON CONFLICT (key) DO NOTHING;
        `).catch((e) => console.log('[LEAD MIGRATION] system_settings insert failed:', e.message));

        console.log('[LEAD MIGRATION] ✅ Migração concluída com sucesso!');
        process.exit(0);
    } catch (error) {
        console.error('[LEAD MIGRATION] ❌ Falha na migração:', error);
        process.exit(1);
    }
}

migrate();
