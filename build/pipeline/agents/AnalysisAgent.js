import OpenAI from 'openai';
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
export class AnalysisAgent {
    /**
     * Analyzes a product image using GPT-4o Vision
     */
    static async analyzeImage(imageUrl) {
        console.log(`[AnalysisAgent] Analyzing image: ${imageUrl}`);
        try {
            const response = await openai.chat.completions.create({
                model: "gpt-4o",
                messages: [
                    {
                        role: "user",
                        content: [
                            {
                                type: "text",
                                text: `Analise esta foto de produto detalhadamente para a criação de um anúncio publicitário.
                                Extraia as seguintes informações:
                                1. O que é o produto?
                                2. Cores principais da identidade visual do produto.
                                3. Público-alvo sugerido.
                                4. Vibe/Estilo do produto (ex: luxo, desportivo, caseiro).
                                5. Elementos visuais importantes presentes na embalagem ou no produto.`
                            },
                            {
                                type: "image_url",
                                image_url: {
                                    "url": imageUrl,
                                },
                            },
                        ],
                    },
                ],
                max_tokens: 500,
            });
            const content = response.choices[0]?.message?.content;
            if (!content)
                throw new Error('Não foi possível obter análise da imagem.');
            console.log(`[AnalysisAgent] Analysis complete.`);
            return content;
        }
        catch (error) {
            console.error('[AnalysisAgent] Error analyzing image:', error.message);
            throw error;
        }
    }
}
