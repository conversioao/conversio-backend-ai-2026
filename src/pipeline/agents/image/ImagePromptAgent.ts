import OpenAI from 'openai';

let openaiInstance: OpenAI | null = null;

function getOpenAI() {
    if (!openaiInstance) {
        if (!process.env.OPENAI_API_KEY) console.error('[ImagePromptAgent] OPENAI_API_KEY is missing!');
        openaiInstance = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
    }
    return openaiInstance;
}

export interface AdOutput {
    prompt: string;
    title: string;
    copy: string;
    hashtags: string;
    metadata?: any;
}

/**
 * ImagePromptAgent — Master router for image ad generation (Generation Engine).
 * Routes to the correct specialized agent based on coreId:
 *   - 'impact-ads-pro' → ImpactAdsProAgent (CV-03)
 *   - 'ugc-realistic'  → UGCRealisticAgent (CV-02)
 *   - default          → General brand visual prompt
 */
export class PromptAgent {
    static async generate(params: {
        analysis: string;
        userPrompt: string;
        coreId?: string;
        core: string;
        style: string;
        useBrandColors?: boolean;
        brandColors?: any;
        currentIndex?: number;
        totalItems?: number;
        contextAntiRepeticao?: string;
        includeText?: boolean;
        seed: number;
    }): Promise<AdOutput> {
        console.log(`[ImagePromptAgent] Routing to agent for core: ${params.core} (ID: ${params.coreId})`);

        if (params.coreId === 'impact-ads-pro') {
            const { ImpactAdsProAgent } = await import('./ImpactAdsProAgent.js');
            return ImpactAdsProAgent.generate({
                analysis: params.analysis,
                userPrompt: params.userPrompt,
                style: params.style,
                useBrandColors: params.useBrandColors || false,
                brandColors: params.brandColors,
                currentIndex: params.currentIndex,
                totalItems: params.totalItems,
                contextAntiRepeticao: params.contextAntiRepeticao,
                includeText: params.includeText,
                seed: params.seed,
            });
        }

        if (params.coreId === 'ugc-realistic') {
            const { UGCRealisticAgent } = await import('./UGCRealisticAgent.js');
            return UGCRealisticAgent.generate({
                analysis: params.analysis,
                userPrompt: params.userPrompt,
                style: params.style,
                seed: params.seed,
            });
        }

        if (params.coreId === 'boutique-fashion') {
            const { BoutiqueFashionAgent } = await import('./BoutiqueFashionAgent.js');
            return BoutiqueFashionAgent.generate({
                analysis: params.analysis,
                userPrompt: params.userPrompt,
                style: params.style,
                seed: params.seed,
            });
        }

        // General brand visual fallback
        console.log(`[ImagePromptAgent] Using general brand visual prompt for core: ${params.core}`);
        const openai = getOpenAI();
        const systemMessage = `Você é um especialista em criação de anúncios visuais de alto impacto para o mercado Angolano.
Gere um prompt técnico detalhado para KIE.ai e o copy publicitário correspondente.
PESSOAS: sempre negras/morenas com traços angolanos.
IDIOMA: Português de Angola (pt-AO).
PRODUTO: ${params.analysis}
CORE: ${params.core} | ESTILO: ${params.style}
INSTRUÇÕES: ${params.userPrompt || "Nenhuma instrução específica. Use o estilo selecionado e a análise do produto para criar um anúncio criativo."}

RESPONDA EM JSON: { "prompt": "...", "title": "...", "copy": "...", "hashtags": "..." }`;

        const response = await openai.chat.completions.create({
            model: "gpt-4o",
            messages: [
                { role: "system", content: systemMessage },
                { role: "user", content: `Gere o anúncio para: ${params.userPrompt || 'estilo ' + params.style}` }
            ],
            response_format: { type: "json_object" }
        });

        const content = response.choices[0]?.message?.content;
        if (!content) throw new Error('[ImagePromptAgent] No content generated.');
        return JSON.parse(content) as AdOutput;
    }
}
