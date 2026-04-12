import OpenAI from 'openai';
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
export class PromptAgent {
    /**
     * Generates a detailed prompt and marketing copy based on analysis and user input.
     */
    static async generate(params) {
        console.log(`[PromptAgent] Generating content for core: ${params.core}`);
        const systemMessage = `Você é um especialista em criação de anúncios visuais de alto impacto para o mercado Angolano.
        
Sua missão é gerar um prompt técnico detalhado para uma IA de geração de imagem (KIE.ai) e o copy publicitário correspondente.

REGRA DE ESTILO: Estética moderna, premium, Midnight Green e Extreme Glassmorphism quando aplicável.
PESSOAS: Se houver pessoas, devem ser negras/morenas com traços angolanos.
IDIOMA: Português de Angola (pt-AO).

PARA O PROMPT DE IMAGEM (EM INGLÊS):
Use a seguinte estrutura: 
1. AD TYPE 
2. BACKGROUND (com cores do produto/marca)
3. GRAPHIC ELEMENTS (partículas, brilhos, ondas)
4. PERSON (descrição física detalhada se aplicável)
5. PRODUCT (posição e destaque)
6. LIGHTING (estúdio profissional)
7. STYLE (4K, highly detailed, professional ad)
8. SEED: ${params.seed}

ANALISE DO PRODUTO:
${params.analysis}

TIPO DE ANÚNCIO (CORE): ${params.core}
ESTILO ESPECÍFICO: ${params.style}
PEDIDO DO UTILIZADOR: ${params.userPrompt}

RESPONDA EXCLUSIVAMENTE EM FORMATO JSON:
{
  "prompt": "O prompt técnico em inglês",
  "title": "Um título curto e impactante (pt-AO)",
  "copy": "Texto publicitário persuasivo com emojis (pt-AO)",
  "hashtags": "#exemplo #angola #publicidade"
}`;
        try {
            const response = await openai.chat.completions.create({
                model: "gpt-4o",
                messages: [
                    { role: "system", content: systemMessage },
                    { role: "user", content: `Gere o anúncio para: ${params.userPrompt}` }
                ],
                response_format: { type: "json_object" }
            });
            const content = response.choices[0]?.message?.content;
            if (!content)
                throw new Error('Falha ao gerar conteúdo do anúncio.');
            const parsed = JSON.parse(content);
            console.log(`[PromptAgent] Content generation complete.`);
            return parsed;
        }
        catch (error) {
            console.error('[PromptAgent] Error generating content:', error.message);
            throw error;
        }
    }
}
