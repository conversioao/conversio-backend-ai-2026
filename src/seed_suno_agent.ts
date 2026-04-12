import { query } from './db.js';

async function migrate() {
    console.log('[Migration] 🎵 Seeding Suno AI Music Agent...');

    try {
        // 1. Add Suno V5 Agent to prompt_agents
        const sunoSystemPrompt = `You are the Suno AI Maestro — an expert in music composition, genre fusion, and lyrical storytelling. Your mission is to transform simple user requests and styles into professional-grade music prompts for the Suno V5 engine.

== MISSION ==
- Generate a creative, catchy 'title' for the song.
- Compose a detailed 'style' description that includes musical technicalities, instruments, mood, and rhythm patterns (BPM, specific drum styles, etc.).
- Compose the 'prompt' (Lyrics). If the music is instrumental, the prompt should describe the musical transition and atmosphere in detail.

== RULES ==
- For Angolan styles (Kuduro, Kizomba, Semba, etc.), use authentic terminology (e.g., 'batida rítmica', 'síncope', 'acordeão de semba').
- If the user specifies 'instrumental', DO NOT generate lyrics. Instead, describe the instrumentation flow.
- Ensure the 'style' string is under 200 characters but extremely dense with high-quality descriptors.
- Determine the 'vocal_gender' (m or f) based on the mood and theme if it's not instrumental.

== OUTPUT FORMAT ==
Return ONLY raw JSON:
{
  "title": "Music Title",
  "style": "Techno, 140bpm, aggressive bass, high-energy...",
  "lyrics": "[Verse 1]\\n... [Chorus]\\n...",
  "vocal_gender": "m" | "f" | "none"
}`;

        const userTemplate = `STYLE: \${style}
INSTRUMENTAL: \${instrumental ? 'Yes' : 'No'}
USER DESIRED THEME/CONCEPT: \${userPrompt}`;

        await query(`
            INSERT INTO prompt_agents (
                technical_id, name, description, category, model_id, 
                system_prompt, user_prompt_template, is_active, params
            ) VALUES (
                'suno-v5', 
                'Suno AI Maestro', 
                'Agente especializado em criar composições musicais e prompts para Suno V5 (KIE.ai).', 
                'music', 
                'gpt-4o', 
                $1, 
                $2, 
                true, 
                '{"temperature": 0.8, "max_tokens": 1500}'
            ) ON CONFLICT (technical_id) DO UPDATE SET 
                system_prompt = EXCLUDED.system_prompt,
                user_prompt_template = EXCLUDED.user_prompt_template;
        `, [sunoSystemPrompt, userTemplate]);

        console.log('✅ Suno AI Agent seeded successfully!');

    } catch (err) {
        console.error('❌ Migration failed:', err);
    } finally {
        process.exit();
    }
}

migrate();
