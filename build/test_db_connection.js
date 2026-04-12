/**
 * test_db_connection.ts
 * Testa a conexão com o banco de dados usando a lógica exata do db.ts
 */
import { pool } from './db.js';
async function test() {
    console.log('[Test] Tentando conectar ao banco de dados...');
    try {
        const start = Date.now();
        const res = await pool.query('SELECT NOW(), current_database(), current_user');
        const duration = Date.now() - start;
        console.log('✅ CONEXÃO ESTABELECIDA!');
        console.log('🕒 Hora do BD:', res.rows[0].now);
        console.log('🗄️ Database:', res.rows[0].current_database);
        console.log('👤 Utilizador:', res.rows[0].current_user);
        console.log('⏱️ Duração:', duration, 'ms');
        // Verificar tabela users
        const usersCount = await pool.query('SELECT count(*) FROM users');
        console.log('👥 Total Utilizadores:', usersCount.rows[0].count);
    }
    catch (error) {
        console.error('❌ ERRO NA CONEXÃO:', error.message);
        if (error.detail)
            console.error('Detalhe:', error.detail);
        if (error.code)
            console.error('Código:', error.code);
    }
    finally {
        await pool.end();
    }
}
test();
