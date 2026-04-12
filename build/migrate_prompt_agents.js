import { query } from './db.js';
async function migrate() {
    try {
        console.log('[PROMPT AGENTS MIGRATION] Starting prompt agents migration...');
        // 1. prompt_agents — configuração dos agentes de lógica
        await query(`
            CREATE TABLE IF NOT EXISTS prompt_agents (
                id SERIAL PRIMARY KEY,
                technical_id VARCHAR(100) UNIQUE,
                name VARCHAR(100) NOT NULL,
                description TEXT,
                category VARCHAR(50) NOT NULL, -- video, image, music, analyzer, engine
                system_prompt TEXT NOT NULL,
                user_prompt_template TEXT,
                few_shot_examples TEXT,
                model_id VARCHAR(100),
                params JSONB DEFAULT '{"temperature": 0.7, "max_tokens": 2000}',
                is_active BOOLEAN DEFAULT true,
                created_at TIMESTAMP DEFAULT now(),
                updated_at TIMESTAMP DEFAULT now()
            );
        `);
        console.log('[PROMPT AGENTS MIGRATION] ✅ prompt_agents table created/verified');
        // Add columns if they don't exist (migration for existing tables)
        await query(`ALTER TABLE prompt_agents ADD COLUMN IF NOT EXISTS technical_id VARCHAR(100) UNIQUE;`);
        await query(`ALTER TABLE prompt_agents ADD COLUMN IF NOT EXISTS user_prompt_template TEXT;`);
        // 2. Seed de agentes padrão da ENGINE
        const coreAgents = [
            {
                technical_id: 'ugc-realistic',
                name: 'UGC RealisticLife',
                category: 'engine',
                description: 'Agente especializado em conteúdo orgânico e autêntico para o mercado Angolano.',
                system_prompt: `You are a specialist in creating organic, authentic-looking advertising content for the Angolan market. 
Your goal is to generate high-impact visual prompts for KIE.ai that look like real, non-professional photos taken with a smartphone.
Focus on casual settings, natural lighting, and modern Angolan people (dark-skinned/brown-skinned Black Angolan people).`,
                user_prompt_template: `Generate 1 UGC-style ad.
PRODUCT DETAILS: \${analysis}
USER INSTRUCTIONS: \${userPrompt}
STYLE: \${style}`
            },
            {
                technical_id: 'impact-ads-pro',
                name: 'ImpactAds Pro',
                category: 'engine',
                description: 'Agente de anúncios de alto impacto visual e copywriting agressivo.',
                system_prompt: `You are a world-class creative director at a top advertising agency. 
Your specialty is creating high-impact, premium visual advertisements specifically for the Angolan market.
You understand Angolan consumer psychology, aspirational lifestyle (Talatona, Miramar), and local slang.`,
                user_prompt_template: `Generate 1 ImpactAds Pro campaign ad. 
CONTEXT FROM ANALYSIS: \${analysis}
USER INSTRUCTIONS: \${userPrompt}
STYLE: \${style}`
            },
            {
                technical_id: 'boutique-fashion',
                name: 'Boutique Fashion Pro',
                category: 'engine',
                description: 'Agente especializado em moda, boutiques, extensões de cabelo e beleza (Angola).',
                system_prompt: `You are a world-class creative director specializing in luxury fashion, beauty, and premium boutiques for the Angolan market.
Focus on fabrics, hair textures, and high-end urban Angolan environments.`,
                user_prompt_template: `PRODUCT ANALYSIS: \${analysis}
USER INSTRUCTION: \${userPrompt}
SELECTED STYLE: \${style}`
            },
            {
                technical_id: 'image-analysis',
                name: 'Image Analysis Vision',
                category: 'analyzer',
                description: 'Agente de visão computacional que analisa o produto para contextualizar a geração.',
                system_prompt: `You are a senior product analyst for a creative advertising agency. Analyze this product image in detail.`,
                user_prompt_template: `Analyze this product for an advertising campaign. Describe it physically and identify the brand/type.`
            }
        ];
        for (const agent of coreAgents) {
            await query(`
                INSERT INTO prompt_agents (technical_id, name, category, description, system_prompt, user_prompt_template)
                VALUES ($1, $2, $3, $4, $5, $6)
                ON CONFLICT (technical_id) DO UPDATE SET
                    system_prompt = EXCLUDED.system_prompt,
                    user_prompt_template = EXCLUDED.user_prompt_template,
                    updated_at = now();
            `, [agent.technical_id, agent.name, agent.category, agent.description, agent.system_prompt, agent.user_prompt_template]);
        }
        console.log('[PROMPT AGENTS MIGRATION] ✅ Core engine agents seeded/updated');
        console.log('[PROMPT AGENTS MIGRATION] ✅ All migrations completed successfully!');
    }
    catch (error) {
        console.error('[PROMPT AGENTS MIGRATION] ❌ Migration failed:', error);
        process.exit(1);
    }
}
migrate();
