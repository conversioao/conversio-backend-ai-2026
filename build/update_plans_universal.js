import { pool } from './db.js';
async function updatePlansFinal() {
    let client;
    try {
        client = await pool.connect();
        console.log('UPDATING ALL PLANS TO UNIVERSAL ACCESS...');
        // We update only the columns that we KNOW exist in the 'plans' table
        const query = `
      UPDATE plans SET 
        realads_image = TRUE,
        realads_video = TRUE,
        brandshot = TRUE,
        lookango = TRUE,
        normal_generation = TRUE,
        text_to_image = TRUE,
        nano_banana_preview = TRUE,
        nano_banana_pro = TRUE,
        nano_banana_2 = TRUE,
        seedream_preview = TRUE,
        seedream_45 = TRUE,
        seedream_50 = TRUE,
        sora_2_preview = TRUE,
        sora_2_pro = TRUE,
        veo_3 = TRUE,
        veo_31 = TRUE,
        watermark = FALSE, -- Watermark OFF for everyone as per "universal access" vibe
        white_label = TRUE,
        api_access = TRUE,
        early_access = TRUE;
    `;
        const res = await client.query(query);
        console.log(`Successfully updated ${res.rowCount} plans with universal access.`);
    }
    catch (err) {
        console.error('Error updating plans:', err);
        process.exit(1);
    }
    finally {
        if (client)
            client.release();
        await pool.end();
    }
}
updatePlansFinal();
