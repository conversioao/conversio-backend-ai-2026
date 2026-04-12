import { OpenAI } from 'openai';
import { query } from '../db.js';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, '../../.env') });
let openaiInstance = null;
const getOpenAIClient = () => {
    if (openaiInstance)
        return openaiInstance;
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) {
        console.warn('[CRM Agent] OPENAI_API_KEY is missing. AI features will be disabled.');
        return null;
    }
    openaiInstance = new OpenAI({ apiKey });
    return openaiInstance;
};
export const generateCampaginWithAI = async (usersContext, promptInput) => {
    const openai = getOpenAIClient();
    if (!openai) {
        throw new Error('Configuração OpenAI ausente. Verifique a chave de API.');
    }
    try {
        const contextString = usersContext.map(u => `ID: ${u.id}, Nome: ${u.name}, Histórico: ${u.interactions}`).join('\n');
        const systemPrompt = `
Você é um estrategista de CRM avançado e redator persuasivo.
A tua tarefa é gerar uma campanha de mensagem de WhatsApp direcionada aos utilizadores da plataforma Conversio.
Aqui está a lista de utilizadores disponíveis no estágio atual com o seu respetivo histórico e IDs:
${contextString}

O Administrador forneceu estas orientações (opcional): ${promptInput || 'Nenhuma, cria a melhor oferta para conversão e engajamento.'}

- Retorna as tuas respostas única e exclusivamente no formato JSON.
- Não utilizes formatação Markdown (\`\`\`json).
- A mensagem deve ser curta, persuasiva, utilizar emojis apropriados, e usar a variável {name} para chamar a pessoa pelo nome próprio.

A resposta deve conter estritamente este JSON:
{
  "audience": [array de IDs recomendados baseados no histórico, seleciona todos que fizer sentido],
  "messageTemplate": "Texto persuasivo a enviar no WhatsApp com a variável {name}",
  "reasoning": "Justificação de menos de duas frases sobre a abordagem escolhida"
}
`;
        const response = await openai.chat.completions.create({
            model: 'gpt-4o',
            messages: [{ role: 'system', content: systemPrompt }],
            temperature: 0.7,
            max_tokens: 400
        });
        const reply = response.choices[0].message.content?.trim() || '{}';
        // Remove markdown wrappers if any
        let cleanJson = reply;
        if (cleanJson.startsWith('```json')) {
            cleanJson = cleanJson.replace('```json', '').replace('```', '').trim();
        }
        else if (cleanJson.startsWith('```')) {
            cleanJson = cleanJson.replace('```', '').replace('```', '').trim();
        }
        return JSON.parse(cleanJson);
    }
    catch (e) {
        console.error('AI Campaign Error:', e);
        throw new Error('Erro ao comunicar com o servidor da OpenAI para gerar a campanha.');
    }
};
export const generateFollowUpWithAI = async (userName, stageName, interactionHistory) => {
    const openai = getOpenAIClient();
    if (!openai) {
        return { message: `Olá ${userName}, notamos que a sua conta tem estado pouco ativa. Tem alguma dúvida de como usar a Conversio AI?` };
    }
    try {
        const systemPrompt = `
Você é o Flavio, mentor e estrategista da Conversio AI. Você é angolano, motivador, humano e foca em ajudar empreendedores a vender mais.
Este utilizador está no estágio "${stageName}". O nome dele é ${userName}.
Histórico: ${interactionHistory || "Acabou de se registar, ainda a explorar."}

OBJECTIVO:
Gera uma mensagem de acompanhamento super persuasiva, natural (estilo angolano "estamos juntos") e curta.
O objetivo é despertar o interesse do cliente, realçando que a Conversio é treinada para Angola e ajuda a produzir conteúdo premium rapidamente.

FORMATO DE RESPOSTA (JSON):
{
  "message": "Texto da mensagem (natural, humano, persuasivo)",
  "mediaType": "video" | "image" | null,
  "mediaReason": "Breve explicação do porquê enviar este vídeo/imagem"
}
`;
        const response = await openai.chat.completions.create({
            model: 'gpt-4o',
            messages: [{ role: 'system', content: systemPrompt }],
            temperature: 0.8,
            max_tokens: 300,
            response_format: { type: "json_object" }
        });
        return JSON.parse(response.choices[0].message.content || '{}');
    }
    catch (e) {
        console.error('AI Follow-up Error:', e);
        return { message: `Olá ${userName}, notamos que está parado no estágio ${stageName}. Tem alguma dúvida na qual possamos ajudar?` };
    }
};
/**
 * MÓDULO C — CRM Actualizado
 */
export async function updateCRMProfile(userId) {
    try {
        console.log(`[CRM Agent] 🔄 Atualizando perfil CRM para ${userId}...`);
        // 1. Calcular LTV e compras
        const statsRes = await query(`
            SELECT 
                COUNT(*) as total_purchases,
                SUM(amount) as lifetime_value,
                AVG(amount) as avg_purchase_value
            FROM transactions
            WHERE user_id = $1 AND status = 'completed'
        `, [userId]);
        const stats = statsRes.rows[0];
        const ltv = parseFloat(stats.lifetime_value || 0);
        const count = parseInt(stats.total_purchases || 0);
        const avg = parseFloat(stats.avg_purchase_value || 0);
        // 2. Determinar canal preferido (baseado em interações)
        const channelRes = await query(`
            SELECT type, COUNT(*) as count 
            FROM crm_interactions 
            WHERE user_id = $1 
            GROUP BY type 
            ORDER BY count DESC 
            LIMIT 1
        `, [userId]);
        const preferredChannel = channelRes.rows[0]?.type || 'whatsapp';
        // 3. Upsert no crm_profiles
        await query(`
            INSERT INTO crm_profiles (user_id, lifetime_value, total_purchases, avg_purchase_value, preferred_channel, last_updated)
            VALUES ($1, $2, $3, $4, $5, NOW())
            ON CONFLICT (user_id) DO UPDATE SET
                lifetime_value = EXCLUDED.lifetime_value,
                total_purchases = EXCLUDED.total_purchases,
                avg_purchase_value = EXCLUDED.avg_purchase_value,
                preferred_channel = EXCLUDED.preferred_channel,
                last_updated = NOW()
        `, [userId, ltv, count, avg, preferredChannel]);
        // 4. Auto-tagging básico
        let tags = [];
        if (ltv > 50000)
            tags.push('vip');
        if (count > 5)
            tags.push('power_user');
        const userRes = await query(`SELECT created_at FROM users WHERE id = $1`, [userId]);
        const createdAt = new Date(userRes.rows[0].created_at);
        const daysSinceSignup = (Date.now() - createdAt.getTime()) / (1000 * 3600 * 24);
        if (daysSinceSignup < 7)
            tags.push('early_adopter');
        if (tags.length > 0) {
            await query(`
                UPDATE crm_profiles 
                SET tags = (SELECT jsonb_agg(DISTINCT x) FROM jsonb_array_elements(tags || $1::jsonb) x)
                WHERE user_id = $2
            `, [JSON.stringify(tags), userId]);
        }
        return { success: true, ltv, tags };
    }
    catch (error) {
        console.error('[CRM Agent] Erro ao atualizar perfil:', error);
        throw error;
    }
}
export async function enrichProfile(userId) {
    const openai = getOpenAIClient();
    if (!openai)
        return null;
    try {
        console.log(`[CRM Agent] 🧠 Enriquecendo perfil para ${userId} com IA...`);
        // Pegar dados completos
        const fullDataRes = await query(`
            SELECT u.name, u.email, u.whatsapp, u.plan, u.created_at,
                   cp.*,
                   (SELECT json_agg(ci.*) FROM (SELECT type, content, created_at FROM crm_interactions WHERE user_id = u.id ORDER BY created_at DESC LIMIT 10) ci) as last_interactions
            FROM users u
            LEFT JOIN crm_profiles cp ON cp.user_id = u.id
            WHERE u.id = $1
        `, [userId]);
        const data = fullDataRes.rows[0];
        if (!data)
            return null;
        const systemPrompt = `
Você é um analista de dados comportamentais. Analisa o utilizador e o seu histórico na Conversio AI.
Dados: ${JSON.stringify(data)}

Gera 3 insights acionáveis no formato JSON estrito:
{
  "insights": ["insight 1", "insight 2", "insight 3"],
  "recommended_action": "ação recomendada imediata",
  "best_channel": "canal ideal",
  "predicted_churn_risk": "low/medium/high",
  "upsell_opportunity": "quem e o que oferecer"
}
`;
        const response = await openai.chat.completions.create({
            model: 'gpt-4o-mini',
            messages: [{ role: 'system', content: systemPrompt }],
            temperature: 0.5,
            max_tokens: 300
        });
        const insights = JSON.parse(response.choices[0].message.content?.trim() || '{}');
        // Salvar insights nas notas do perfil
        await query(`
            UPDATE crm_profiles 
            SET notes = $1, last_updated = NOW() 
            WHERE user_id = $2
        `, [JSON.stringify(insights), userId]);
        return insights;
    }
    catch (e) {
        console.error('[CRM Agent] AI Enrichment Error:', e);
        return null;
    }
}
