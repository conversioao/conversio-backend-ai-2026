import { query } from '../db.js';
import { sendWhatsAppMessage, sendWhatsAppVideo } from './whatsappService.js';
import { OpenAI } from 'openai';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, '../../.env') });

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

/**
 * Agente de Qualificação de Leads WhatsApp
 */
export class WhatsAppLeadAgent {
    
    /**
     * Processa uma mensagem recebida da Evolution API
     */
    static async handleIncomingMessage(remoteJid: string, pushName: string, text: string) {
        try {
            const phone = remoteJid.split('@')[0];
            console.log(`[LeadAgent] 📩 Mensagem de ${phone} (${pushName}): ${text}`);

            // 1. Verificar se o número já é um utilizador registado
            const userRes = await query('SELECT id, name, context_briefing FROM users WHERE whatsapp = $1', [phone]);
            const isRegisteredUser = userRes.rows.length > 0;
            if (isRegisteredUser) {
                console.log(`[LeadAgent] Utilizador já registado (${userRes.rows[0].name}). O Agente vai prestar suporte.`);
            }

            // 2. Localizar ou criar o Lead
            let leadRes = await query('SELECT * FROM whatsapp_leads WHERE phone = $1', [phone]);
            let lead;
            if (leadRes.rows.length === 0) {
                const insertRes = await query(
                    'INSERT INTO whatsapp_leads (phone, name, status) VALUES ($1, $2, $3) RETURNING *',
                    [phone, pushName, 'new']
                );
                lead = insertRes.rows[0];
            } else {
                lead = leadRes.rows[0];
            }

            // 3. Verificar se a IA está ativa para este lead
            if (!lead.agent_active) {
                console.log(`[LeadAgent] 😴 Agente inativo para este lead (modo humano).`);
                return;
            }

            // 4. Salvar mensagem do utilizador no histórico
            await query(
                'INSERT INTO whatsapp_messages (lead_id, role, content) VALUES ($1, $2, $3)',
                [lead.id, 'user', text]
            );

            // 5. Obter histórico recente para contexto (últimas 10 mensagens)
            const historyRes = await query(
                'SELECT role, content FROM whatsapp_messages WHERE lead_id = $1 ORDER BY created_at ASC LIMIT 10',
                [lead.id]
            );
            
            const systemPromptRes = await query("SELECT value FROM system_settings WHERE key = 'whatsapp_agent_prompt'");
            const basePrompt = systemPromptRes.rows[0]?.value || `Você é o Alex, especialista em sucesso do cliente da Conversio AI. Seu tom de voz é inspirado no Flavio: natural, humano, caloroso e focado em converter leads angolanos.
            
            DIRETRIZES:
            1. Frise que a Conversio é Angolana e aceita pagamentos em Kwanza (Kz).
            2. Ofereça 50 Créditos Grátis para testar (gera 10+ mídias).
            3. Use o link www.conversio.ao para cadastro.
            4. Se tiver dúvidas de como cadastrar ou como usar a plataforma, sinalize nos triggers.`;
            
            const systemContext = `
${basePrompt}

Dados Actuais do Lead:
- Nome: ${lead.name || 'Desconhecido'}
- Negócio: ${lead.business_info || 'Ainda não identificado'}
- Necessidade: ${lead.needs || 'Ainda não identificado'}

INSTRUÇÕES DE RESPOSTA (JSON):
Responda APENAS com um JSON no formato:
{
  "reply": "Texto para o WhatsApp",
  "extracted_data": {
    "name": "nome se identificado",
    "business_info": "ramo se identificado",
    "needs": "necessidade se identificada"
  },
  "is_qualified": boolean,
  "trigger_video_cadastro": true/false,
  "trigger_video_uso": true/false
}

GATILHOS:
- trigger_video_cadastro: use quando o cliente não souber criar conta.
- trigger_video_uso: use quando o cliente não souber gerar/usar as ferramentas da plataforma.
`;

            const messages: any[] = [
                { role: "system", content: systemContext }
            ];

            // Add history to ensure continuity
            historyRes.rows.forEach(m => {
                messages.push({ 
                    role: m.role === 'user' ? 'user' : 'assistant', 
                    content: m.content 
                });
            });

            // 6. Chamar OpenAI para gerar resposta e extrair dados
            const completion = await openai.chat.completions.create({
                model: "gpt-4o",
                messages,
                response_format: { type: "json_object" }
            });

            const result = JSON.parse(completion.choices[0].message.content || '{}');
            const { reply, extracted_data, is_qualified, trigger_video_cadastro, trigger_video_uso } = result;

            // 7. Atualizar dados do Lead
            await query(
                `UPDATE whatsapp_leads SET 
                    name = COALESCE($1, name),
                    business_info = COALESCE($2, business_info),
                    needs = COALESCE($3, needs),
                    status = $4,
                    last_interaction = NOW()
                WHERE id = $5`,
                [extracted_data?.name, extracted_data?.business_info, extracted_data?.needs, is_qualified ? 'qualified' : 'in_progress', lead.id]
            );

            // 8. Salvar resposta da IA no histórico
            await query(
                'INSERT INTO whatsapp_messages (lead_id, role, content) VALUES ($1, $2, $3)',
                [lead.id, 'agent', reply]
            );

            // 9. Enviar mensagem via WhatsApp
            const typingDelayMs = Math.floor(Math.random() * (60000 - 40000 + 1)) + 40000;
            await sendWhatsAppMessage(phone, reply, 'agent_action', typingDelayMs);

            // 10. Processar Disparo de Vídeos (Triggers)
            if (trigger_video_cadastro) {
                const videoUrl = process.env.VIDEO_CADASTRO_URL || 'https://conversio.ao/videos/cadastro.mp4';
                await sendWhatsAppVideo(phone, videoUrl, 'Aqui tens um vídeo rápido explicando como te cadastrar na plataforma! 🎥');
            } else if (trigger_video_uso) {
                const videoUrl = process.env.VIDEO_USO_URL || 'https://conversio.ao/videos/como_usar.mp4';
                await sendWhatsAppVideo(phone, videoUrl, 'Fizemos este vídeo para te mostrar como é fácil gerar conteúdo na Conversio AI! 🚀');
            }

            // 10. Se qualificado, realizar o Handover (Agentes conversam)
            if (is_qualified) {
                await this.performHandover(lead, extracted_data);
            }

        } catch (error: any) {
            console.error('[LeadAgent] Erro crítico ao processar lead:', error.message || error);
            if (error.response) {
                console.error('[LeadAgent] API Response Error:', error.response.data);
            }
        }
    }

    /**
     * Passagem de contexto para os agentes do funil
     */
    static async performHandover(lead: any, data: any) {
        console.log(`[LeadAgent] 🎯 Lead Qualificado: ${lead.phone}. Iniciando Handover...`);

        // Gerar um Briefing resumido para o próximo agente
        const briefingPrompt = `Resuma em uma frase o que o cliente ${data.name} da empresa ${data.business_info} precisa (Foco: ${data.needs}).`;
        const briefingComp = await openai.chat.completions.create({
            model: "gpt-4o-mini",
            messages: [{ role: "user", content: briefingPrompt }]
        });
        const briefing = briefingComp.choices[0].message.content;

        // Criar notificação para o Admin
        await query(
            `INSERT INTO admin_notifications (type, title, message, icon, color, reference_id, reference_type)
             VALUES ($1, $2, $3, $4, $5, $6, $7)`,
            ['lead_qualified', '🎯 Novo Lead Qualificado', `O lead ${data.name} (${lead.phone}) foi qualificado automaticamente pela IA.`, '🎯', 'green', lead.id, 'whatsapp_lead']
        );

        // Agendar tarefa para o Agente Funil via Orquestrador (com o briefing no payload)
        // Nota: Como o lead ainda não tem userId, guardamos o briefing no whatsapp_leads 
        // para quando ele se registar, ser transferido para o users.context_briefing.
        await query(
            `UPDATE whatsapp_leads SET business_info = $1 WHERE id = $2`,
            [briefing, lead.id]
        );

        // Agendar tarefa para o Funil Agent tratar a continuação da negociação
        await query(
            `INSERT INTO agent_tasks (agent_name, task_type, payload, priority) VALUES ($1, $2, $3, $4)`,
            ['FunnelAgent', 'engage_lead', JSON.stringify({ leadId: lead.id, action: 'start_campaign', source: 'whatsapp', briefing }), 1]
        ).catch(e => console.error('[LeadAgent] Erro ao agendar tarefa de Funil:', e.message));

        
        console.log(`[LeadAgent] ✅ Handover concluído com briefing: ${briefing}`);
    }
}
