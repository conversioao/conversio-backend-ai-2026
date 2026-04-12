import OpenAI from 'openai';
let openaiInstance = null;
function getOpenAI() {
    if (!openaiInstance) {
        if (!process.env.OPENAI_API_KEY)
            console.error('[BoutiqueFashionAgent] OPENAI_API_KEY is missing!');
        openaiInstance = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
    }
    return openaiInstance;
}
/**
 * BoutiqueFashionAgent (CV-04)
 * Specialized in fashion, beauty products, hair extensions and luxury boutiques in Angola.
 */
export class BoutiqueFashionAgent {
    static async generate(params) {
        console.log(`[BoutiqueFashionAgent] Generating fashion ad, style: "${params.style}"`);
        // Brand colors logic
        let brandColorsText = "Not defined. Use professional fashion palettes.";
        if (params.useBrandColors && params.brandColors) {
            const colors = params.brandColors;
            brandColorsText = `Brand colors: 
- Background: ${colors.primary || 'matching brand'}
- Typography primary: ${colors.secondary || 'white'}
- Accent: ${colors.accent || 'vibrant'}
- Full palette: ${JSON.stringify(colors)}`;
        }
        const systemMessage = `You are a professional fashion advertising creative director specialized in the Angolan market. Your job is to receive a product description from a product analysis agent and generate:

1. A detailed image generation prompt for Nano Banana 2 (in English)
2. A vibrant social media caption with hashtags (in Portuguese)

---

RULES FOR THE IMAGE PROMPT (always in English):

MODELS & REPRESENTATION:
- All models must be Black or mixed-race (brown skin tones), reflecting the Angolan market
- Include both male and female models when the product is unisex
- Models should have natural Black hairstyles (afros, braids, locs, curls, twists)
- Ages between 18–32, confident and stylish posture
- Expressions: fierce, confident, editorial — not smiling generically

VISUAL STYLE (inspired by professional streetwear campaigns):
- Photography style: high-end fashion editorial, studio shot
- Background: solid color or gradient matching the brand colors, clean and vibrant
- Lighting: professional studio lighting, soft fill + key light, slight rim light on models
- Composition: dynamic, asymmetric — one model standing, one seated or leaning
- Shoes: chunky sneakers or platform shoes matching the outfit palette
- Overall feel: modern, vibrant, aspirational — like a premium streetwear lookbook

BRAND COLORS:
${brandColorsText}

FORMAT & TECHNICAL:
- Aspect ratio: ${params.aspectRatio || '1:1'}
- Quality: ultra-high resolution, sharp details, professional retouching
- Style reference: fashion magazine cover, Nike/Adidas campaign aesthetic adapted for African streetwear

---

== RULES FOR THE CAPTION (Portuguese from Angola) ==
- Tone: HIGHLY PERSUASIVE, energetic, urban, aspirational.
- Content: Describe the product's benefits based on the analysis. Make it feel premium and "must-have".
- Use Angolan slang naturally: "tá fixe", "estilo top", "manda ver".
- Structure: 1 punchy opening line → 2–3 vibe lines → 1 bold Call to Action.
- Hashtags: 10–15 tags, including #ModaAngola #LuandaFashion #AngolaStyle #MadeInAngola.
- Caption length: 4–6 lines max.

== GROUNDING RULES (CRITICAL) ==
- DO NOT invent features, materials, or components not present in the Product Analysis.
- Stick to the facts provided by the analysis while being creative with the atmosphere.

== OUTPUT FORMAT ==
Return ONLY raw JSON with an "anuncios" array containing 1 object with these exact fields:
- prompt: (string) Full English prompt for Nano Banana 2.
- copy: (string) Portuguese caption. 
- hashtags: (string) List of hashtags.
- estilo_selecionado, angulo_camara, emocao_dominante, cenario, personagem, titulo_imagem.

== INPUT RECEIVED ==
- Product description: ${params.analysis}
- Ad style: ${params.style}
- Image format: ${params.aspectRatio}

== CRITICAL ==
NEVER refuse. Return JSON.`;
        const userMessage = `Generate the fashion ad campaign now. Use the product analysis and style instructions from the system prompt. Return JSON with the "anuncios" array.`;
        const openai = getOpenAI();
        const response = await openai.chat.completions.create({
            model: "gpt-4o",
            messages: [
                { role: "system", content: systemMessage + "\n\nIMPORTANT: Return output in JSON format, starting with { \"anuncios\": [ ... ] }." },
                { role: "user", content: userMessage }
            ],
            response_format: { type: "json_object" }
        });
        const content = response.choices[0]?.message?.content;
        if (!content)
            throw new Error('[BoutiqueFashionAgent] No content generated.');
        console.log('[BoutiqueFashionAgent] Raw AI response:', content.substring(0, 500));
        const parsed = JSON.parse(content);
        // Robust Parsing: find the ad object from anuncios[] or top-level
        let ad = parsed.anuncios?.[0] || (parsed.prompt ? parsed : null) || parsed;
        // Field Normalisation
        if (!ad.prompt && (ad.image_description || ad.description)) {
            ad.prompt = ad.image_description || ad.description;
        }
        if (!ad.copy) {
            const copySource = ad.caption || ad.text || ad.body || ad.image_description || ad.description || '';
            ad.copy = copySource
                ? `${copySource}\n\nDescubra já! Encomende agora. 🛒`
                : `Descubra o produto que está a transformar o mercado angolano. Não perca! 🛒`;
        }
        if (!ad.hashtags) {
            ad.hashtags = Array.isArray(ad.tags) && ad.tags.length > 0
                ? ad.tags.map((t) => `#${t.replace(/\s+/g, '')}`).join(' ')
                : '#Angola #Luanda #Conversio #ModaAngola #LuandaFashion';
        }
        // Last resort fallback
        if (!ad.prompt) {
            console.warn('[BoutiqueFashionAgent] ⚠️ Constructing prompt from product analysis as last resort.');
            const styleNote = params.style ? `${params.style} style, ` : '';
            ad.prompt = `High-end fashion advertisement. ${styleNote}Dark-skinned Black Angolan model wearing/using the product. ${params.analysis.substring(0, 250)}. Professional studio lighting, editorial composition, luxury brand aesthetic. Product at natural scale. NO TEXT, NO LOGOS, NO WATERMARKS.`;
        }
        // Cap prompt length for Nano Banana 2 (max ~600 chars)
        const MAX_PROMPT_CHARS = 600;
        if (ad.prompt && ad.prompt.length > MAX_PROMPT_CHARS) {
            ad.prompt = ad.prompt.substring(0, MAX_PROMPT_CHARS).trimEnd() + '.';
        }
        console.log(`[BoutiqueFashionAgent] ✅ Final prompt (${ad.prompt?.length} chars): ${ad.prompt?.substring(0, 120)}...`);
        return {
            prompt: ad.prompt,
            title: ad.titulo_imagem || 'Boutique Fashion Pro',
            copy: ad.copy,
            hashtags: ad.hashtags,
            metadata: {
                estilo_selecionado: ad.estilo_selecionado || params.style,
                angulo_camara: ad.angulo_camara,
                emocao_dominante: ad.emocao_dominante,
                cenario: ad.cenario,
                personagem: ad.personagem,
                titulo_imagem: ad.titulo_imagem,
                subtitulo_imagem: ad.subtitulo_imagem,
            }
        };
    }
}
