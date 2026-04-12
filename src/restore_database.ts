/**
 * restore_database.ts
 * Restaura o banco de dados a partir do ficheiro SQL de backup.
 * Uso: npx tsx src/restore_database.ts [caminho/para/backup.sql]
 */

import { Pool } from 'pg';
import * as fs from 'fs';
import * as path from 'path';
import * as dotenv from 'dotenv';

// Carregar variáveis de ambiente
dotenv.config();

const pool = new Pool({
  host: process.env.DB_HOST || 'localhost',
  port: parseInt(process.env.DB_PORT || '5432'),
  user: process.env.DB_USER || 'postgres',
  password: process.env.DB_PASS || '',
  database: process.env.DB_NAME || 'conversioao',
  ssl: false,
  connectionTimeoutMillis: 15000,
});

async function restore() {
  // Tentar pegar o arquivo dos argumentos ou procurar o mais recente no diretório atual
  let sqlFile = process.argv[2];

  if (!sqlFile) {
    const files = fs.readdirSync(process.cwd())
      .filter(f => f.startsWith('backup_conversio_ao_') && f.endsWith('.sql'))
      .sort()
      .reverse();
    
    if (files.length > 0) {
      sqlFile = path.join(process.cwd(), files[0]);
    }
  } else {
    sqlFile = path.resolve(sqlFile);
  }

  if (!sqlFile || !fs.existsSync(sqlFile)) {
    console.error('❌ Ficheiro de backup não encontrado. Por favor especifique um caminho.');
    process.exit(1);
  }

  console.log('📄 A usar ficheiro:', sqlFile);
  const sql = fs.readFileSync(sqlFile, 'utf8');
  const client = await pool.connect();

  console.log('🔌 Conectado ao PostgreSQL:', pool.options.host, '/', pool.options.database);
  console.log('🚀 A iniciar restauração...');

  try {
    // Para restauração completa, usamos um bloco BEGIN/COMMIT
    // Nota: O arquivo gerado pelo backup_database.ts já desativa triggers
    await client.query('BEGIN');
    
    // Executar o SQL do backup
    await client.query(sql);
    
    await client.query('COMMIT');
    console.log('✅ Restauração concluída com sucesso!');
  } catch (err: any) {
    await client.query('ROLLBACK');
    console.error('❌ ERRO na restauração:', err.message);
    if (err.detail) console.error('Detalhe:', err.detail);
    if (err.where) console.error('Onde:', err.where);
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
}

restore().catch(err => {
  console.error('❌ ERRO inesperado:', err.message);
  process.exit(1);
});

