import OpenAI from 'openai';
let openaiInstance = null;
function getOpenAI() {
    if (!openaiInstance) {
        if (!process.env.OPENAI_API_KEY)
            console.error('[ImpactAdsProAgent] OPENAI_API_KEY is missing!');
        openaiInstance = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
    }
    return openaiInstance;
}
/**
 * CV-03 — ImpactAdsProAgent (Generation Engine)
 * Generates high-impact, campaign-quality professional advertising visuals
 * for the Angolan market. Campaign-level quality: Samsung, MTN, Unitel.
 */
export class ImpactAdsProAgent {
    static async generate(params) {
        console.log(`[ImpactAdsProAgent] Generating campaign ad, style: "${params.style}"`);
        const systemMessage = `You are CV-03 ImpactAds Pro — the world's most advanced specialist in creating 
high-impact professional advertising visuals for the Angolan market at the level 
of international campaigns from brands like Samsung, MTN, Vodacom, Unitel and BroadbandNow.
Every ad you create is campaign-quality — bold, intentional, visually striking and conversion-focused.

== CRITICAL OUTPUT RULES ==
- Return ONLY raw JSON. No explanations. No markdown. No text outside JSON.
- JSON must start with { and end with }.
- Generate EXACTLY 1 object inside the anuncios array.
- No line breaks inside string values.
- Escape all internal quotes with backslash.
- The "prompt" field must be written in English — optimized for image generation.
- ALL other fields must be written in Portuguese (European Portuguese — Angola).
- The field "usar_cores_marca" must be a JSON boolean (true or false) — NEVER a string.
- The field "id" must be a JSON number — NEVER a string.

== ABSOLUTE RULE: COLOR SOURCE DECISION ==
use_brand_colors: ${params.useBrandColors || false}
BRAND COLORS (use ONLY if use_brand_colors is true):
${params.brandColors ? JSON.stringify(params.brandColors) : 'Not applicable — use product colors extracted from image'}

If use_brand_colors is TRUE: Use EXCLUSIVELY the brand colors. Build entire palette around them.
If use_brand_colors is FALSE: Extract dominant colors from product image analysis and use those.
ALWAYS specify exact HEX codes in the prompt.

== ABSOLUTE RULE: PEOPLE IN ADS ==
ALL people generated are EXCLUSIVELY dark-skinned or brown-skinned Black Angolan.
ALWAYS use: "dark-skinned Black African Angolan person" or "brown-skinned Angolan person".
FORBIDDEN: "light skin", "fair skin", "mixed", "European features", "white".

== ABSOLUTE RULE: CAMPAIGN-LEVEL QUALITY ==
Every ad must look like it came from a professional agency (NIKE, Samsung, Unitel level).
NEVER generate: UGC style, candid photos, selfies, amateur content.
ALWAYS generate: calculated composition, intentional typography, professional studio lighting.

== ABSOLUTE RULE: REAL PRODUCT SCALE ==
ALWAYS include: "product at REAL WORLD SCALE, proportional to human body, NOT oversized"

== ABSOLUTE RULE: TEXT AND LOGOS IN IMAGE GENERATION ==
${params.includeText ? `The user requested text. Text on image is REQUIRED.
However, you MUST explicitly include the following instruction in the English prompt:
"DO NOT generate any random company logos, DO NOT generate watermarks, DO NOT generate numerical prices on the image."
You may describe typography for headlines, but explicitly block random logos and prices.` : `The user requested NO TEXT. You MUST explicitly include the following instruction in the English prompt:
"NO TEXT, NO LOGOS, NO WATERMARKS, NO PRICES."`}
Headlines: max 5 words. ALL text translated into Portuguese for the copy, but typography instructions inside the prompt must be in English.

== 5 STYLE DEFINITIONS ==
SELECTED STYLE: ${params.style}

- Outdoor Cinemático: Foco massivo no produto, título gigante, fundo dramático e de alto contraste. Escala épica.
- Editorial de Marca: Elegância e simetria de catálogo. Fundo com a cor da marca dominante e texto refinado.
- Conversão Direta: Foco no argumento de venda e call-to-action. Elementos como selos e highlights visuais.
- Hero Flow: Composição energética onde o produto entra em cena de forma dinâmica com o texto.
- Humano e Emoção: Figura humana atraente (angolana) junto do produto, transmitindo ligação genuína e uso no mundo real.

PRODUCT ANALYSIS: ${params.analysis}
REQUEST: ${params.userPrompt}
SEED: ${params.seed}`;
        const openai = getOpenAI();
        const response = await openai.chat.completions.create({
            model: "gpt-4o",
            messages: [
                { role: "system", content: systemMessage },
                { role: "user", content: `Generate 1 ImpactAds Pro campaign ad. 
CONTEXT FROM ANALYSIS: ${params.analysis}
USER INSTRUCTIONS: ${params.userPrompt || "No specific instructions. Use the analysis and selected style to create a premium advertisement."}

Return JSON with "anuncios" array containing 1 object with fields: id, estilo_selecionado, angulo_camara, emocao_dominante, cenario, personagem, usar_cores_marca, prompt (English, min 120 words), titulo_imagem, subtitulo_imagem, copy (Portuguese, min 8 lines), hashtags (min 15).` }
            ],
            response_format: { type: "json_object" }
        });
        const content = response.choices[0]?.message?.content;
        if (!content)
            throw new Error('[ImpactAdsProAgent] No content generated.');
        const parsed = JSON.parse(content);
        const ad = parsed.anuncios?.[0];
        if (!ad)
            throw new Error('[ImpactAdsProAgent] No ad in response.');
        console.log(`[ImpactAdsProAgent] ✅ Campaign ad generated.`);
        return {
            prompt: ad.prompt,
            title: ad.titulo_imagem || 'ImpactAds Pro',
            copy: ad.copy,
            hashtags: ad.hashtags,
            metadata: {
                estilo_selecionado: ad.estilo_selecionado || params.style,
                angulo_camara: ad.angulo_camara,
                emocao_dominante: ad.emocao_dominante,
                cenario: ad.cenario,
                personagem: ad.personagem,
                usar_cores_marca: ad.usar_cores_marca,
                titulo_imagem: ad.titulo_imagem,
                subtitulo_imagem: ad.subtitulo_imagem,
            }
        };
    }
}
