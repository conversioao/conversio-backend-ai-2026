import OpenAI from 'openai';

let openaiInstance: OpenAI | null = null;

function getOpenAI() {
    if (!openaiInstance) {
        const apiKey = process.env.OPENAI_API_KEY;
        if (!apiKey) {
            console.error('[BrandColorExtractorAgent] CRITICAL: OPENAI_API_KEY is missing from environment variables.');
            throw new Error('Chave de API OpenAI (OPENAI_API_KEY) não configurada no servidor backend.');
        }
        openaiInstance = new OpenAI({ apiKey });
    }
    return openaiInstance;
}

export interface BrandAnalysisOutput {
    company_name: string;
    brand_colors: {
        primary: string;
        secondary: string;
        accent: string | null;
        background: string;
        tone: 'dark' | 'light' | 'vibrant' | 'muted';
        palette: string[];
        palette_description: string;
    };
}

/**
 * BrandColorExtractorAgent
 * Analyzes a given logo image URL using OpenAI Vision to extract brand identity colors 
 * and infer the company name. Designed to replace the legacy n8n webhook.
 */
export class BrandColorExtractorAgent {
    static async analyze(imageUrl: string): Promise<BrandAnalysisOutput> {
        console.log(`[BrandColorExtractorAgent] Analyzing logo at URL: ${imageUrl}`);
        const openai = getOpenAI();

        const systemMessage = `És um especialista em Design Guiado e Identidade de Marca (Branding).
A tua missão é olhar para um logótipo fornecido e extrair, com a máxima precisão, a identidade visual exata em formato HEX.

DEVES CUMPRIR AS SEGUINTES REGRAS EXATAMENTE:
1. Responde APENAS com um objeto JSON puro. Nenhuma marcação Markdown.
2. Formato obrigatório:
{
    "company_name": "Nome visível no logotipo ou 'A Minha Marca' se não houver texto",
    "brand_colors": {
        "primary": "#HEX",
        "secondary": "#HEX",
        "accent": "#HEX ou null",
        "background": "#HEX (cor predominante para o fundo apropriado, geralmente escuro se o logotipo for claro)",
        "tone": "dark" | "light" | "vibrant" | "muted",
        "palette": ["#HEX1", "#HEX2", "#HEX3"],
        "palette_description": "Breve descrição em Português de Angola da paleta"
    }
}
3. Nunca inventes cores. Lê os tons reais dos píxeis do logótipo.`;

        const response = await openai.chat.completions.create({
            model: 'gpt-4o',
            messages: [
                { role: 'system', content: systemMessage },
                {
                    role: 'user',
                    content: [
                        { type: 'text', text: 'Extrai a paleta de cores e o nome desta marca.' },
                        { type: 'image_url', image_url: { url: imageUrl } }
                    ]
                }
            ],
            response_format: { type: 'json_object' }
        });

        const content = response.choices[0]?.message?.content;
        if (!content) {
            throw new Error('[BrandColorExtractorAgent] O modelo GPT-4o não devolveu conteúdo.');
        }

        const parsed = JSON.parse(content) as BrandAnalysisOutput;
        return parsed;
    }
}
