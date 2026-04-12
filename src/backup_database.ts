/**
 * backup_database.ts
 * Faz dump completo do PostgreSQL (schema + dados) para um ficheiro .sql
 * Uso: npx tsx src/backup_database.ts
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

function escapeValue(val: any): string {
  if (val === null || val === undefined) return 'NULL';
  if (typeof val === 'boolean') return val ? 'TRUE' : 'FALSE';
  if (typeof val === 'number') return String(val);
  if (val instanceof Date) return `'${val.toISOString()}'`;
  if (typeof val === 'object') return `'${JSON.stringify(val).replace(/'/g, "''")}'`;
  // Strings — escape single quotes
  return `'${String(val).replace(/'/g, "''")}'`;
}

async function backup() {
  const client = await pool.connect();
  const date = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const outFileName = `backup_conversio_ao_${date}.sql`;
  const outFile = path.join(process.cwd(), outFileName);
  const lines: string[] = [];

  console.log('🔌 Conectado ao PostgreSQL:', pool.options.host);

  lines.push(`-- =====================================================`);
  lines.push(`-- BACKUP COMPLETO (SISTEMA DE MIGRAÇÃO) — ${pool.options.database}`);
  lines.push(`-- Data: ${new Date().toISOString()}`);
  lines.push(`-- Host: ${pool.options.host}`);
  lines.push(`-- =====================================================`);
  lines.push(``);
  lines.push(`SET client_encoding = 'UTF8';`);
  lines.push(`SET standard_conforming_strings = on;`);
  lines.push(`SET check_function_bodies = false;`);
  lines.push(`SET xmloption = content;`);
  lines.push(`SET client_min_messages = warning;`);
  lines.push(`SET row_security = off;`);
  lines.push(``);
  
  // Desativar triggers temporariamente para evitar erros de FK durante a carga de dados massiva
  lines.push(`SET session_replication_role = 'replica';`);
  lines.push(``);

  // 1. Listar todas as tabelas do schema public
  const tablesRes = await client.query(`
    SELECT tablename FROM pg_tables
    WHERE schemaname = 'public'
    ORDER BY tablename
  `);

  const tables: string[] = tablesRes.rows.map((r: any) => r.tablename);
  console.log(`📋 Tabelas encontradas (${tables.length}):`, tables.join(', '));

  // 2. Para cada tabela: obter o CREATE TABLE e os dados
  for (const table of tables) {
    console.log(`  ⬇️  A exportar tabela: ${table}`);

    // Schema da tabela via information_schema
    const colsRes = await client.query(`
      SELECT
        column_name,
        data_type,
        character_maximum_length,
        is_nullable,
        column_default
      FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = $1
      ORDER BY ordinal_position
    `, [table]);

    // Build CREATE TABLE
    lines.push(`-- ---------------------------------------------------`);
    lines.push(`-- Tabela: ${table}`);
    lines.push(`-- ---------------------------------------------------`);
    lines.push(`DROP TABLE IF EXISTS "${table}" CASCADE;`);
    lines.push(`CREATE TABLE "${table}" (`);

    const colDefs = colsRes.rows.map((col: any) => {
      let def = `  "${col.column_name}" ${col.data_type}`;
      if (col.character_maximum_length) def += `(${col.character_maximum_length})`;
      if (col.column_default && !col.column_default.includes('nextval')) {
        def += ` DEFAULT ${col.column_default}`;
      } else if (col.column_default && col.column_default.includes('nextval')) {
        // Handle serial types implicitly if needed, but for dump we keep defaults
        def += ` DEFAULT ${col.column_default}`;
      }
      if (col.is_nullable === 'NO') def += ` NOT NULL`;
      return def;
    });

    // PK constraints
    const pkRes = await client.query(`
      SELECT
        tc.constraint_name,
        kcu.column_name
      FROM information_schema.table_constraints AS tc
      JOIN information_schema.key_column_usage AS kcu
        ON tc.constraint_name = kcu.constraint_name
        AND tc.table_schema = kcu.table_schema
      WHERE tc.table_schema = 'public' AND tc.table_name = $1
        AND tc.constraint_type = 'PRIMARY KEY'
    `, [table]);

    if (pkRes.rows.length > 0) {
      const pkName = pkRes.rows[0].constraint_name;
      const pkCols = pkRes.rows.map((r: any) => `"${r.column_name}"`).join(', ');
      colDefs.push(`  CONSTRAINT "${pkName}" PRIMARY KEY (${pkCols})`);
    }

    lines.push(colDefs.join(',\n'));
    lines.push(`);`);
    lines.push(``);

    // Indexes (except PKing ones)
    const indexRes = await client.query(`
      SELECT indexname, indexdef
      FROM pg_indexes
      WHERE schemaname = 'public' AND tablename = $1
        AND indexname NOT IN (
          SELECT constraint_name FROM information_schema.table_constraints
          WHERE table_name = $1 AND constraint_type = 'PRIMARY KEY'
        )
    `, [table]);

    for (const idx of indexRes.rows) {
      lines.push(`${idx.indexdef};`);
    }
    if (indexRes.rows.length > 0) lines.push(``);

    // Sequences reset logic (simpler version)
    const seqRes = await client.query(`
      SELECT column_name, column_default
      FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = $1
        AND column_default LIKE 'nextval%'
    `, [table]);
    
    for (const s of seqRes.rows) {
      const match = s.column_default.match(/nextval\('([^']+)'/);
      if (match) {
        const seqName = match[1];
        // Ensure sequence exists
        const seqExists = await client.query(`SELECT 1 FROM pg_class WHERE relname = $1 AND relkind = 'S'`, [seqName.split('.').pop()?.replace(/"/g, '')]);
        if (seqExists.rowCount! > 0) {
          const seqValRes = await client.query(`SELECT last_value FROM ${seqName}`).catch(() => null);
          if (seqValRes && seqValRes.rows.length > 0) {
            lines.push(`SELECT setval('${seqName}', ${seqValRes.rows[0].last_value}, true);`);
          }
        }
      }
    }

    // Dados — INSERT INTO — Using single INSERT with multiple VALUES for efficiency
    const dataRes = await client.query(`SELECT * FROM "${table}"`);
    const rowCount = dataRes.rows.length;
    console.log(`     → ${rowCount} registos`);

    if (rowCount > 0) {
      const colNames = dataRes.fields.map((f: any) => `"${f.name}"`).join(', ');
      lines.push(``);
      lines.push(`-- Dados: ${rowCount} registos`);

      // Batch inserts to be faster
      const BATCH_SIZE = 500;
      for (let i = 0; i < rowCount; i += BATCH_SIZE) {
        const batch = dataRes.rows.slice(i, i + BATCH_SIZE);
        const valuesList = batch.map(row => {
          return `(${dataRes.fields.map((f: any) => escapeValue(row[f.name])).join(', ')})`;
        }).join(',\n  ');
        
        lines.push(`INSERT INTO "${table}" (${colNames}) VALUES \n  ${valuesList}\nON CONFLICT DO NOTHING;`);
      }
    }

    lines.push(``);
  }

  // Handle Foreign Keys LAST to ensure all tables exist
  console.log('🔗 Adicionando Constraints de Chaves Estrangeiras...');
  for (const table of tables) {
    const fkRes = await client.query(`
      SELECT
        tc.constraint_name,
        kcu.column_name,
        ccu.table_name AS foreign_table_name,
        ccu.column_name AS foreign_column_name
      FROM information_schema.table_constraints AS tc
      JOIN information_schema.key_column_usage AS kcu
        ON tc.constraint_name = kcu.constraint_name
        AND tc.table_schema = kcu.table_schema
      JOIN information_schema.constraint_column_usage AS ccu
        ON ccu.constraint_name = tc.constraint_name
        AND ccu.table_schema = tc.table_schema
      WHERE tc.table_schema = 'public' AND tc.table_name = $1
        AND tc.constraint_type = 'FOREIGN KEY'
    `, [table]);

    for (const fk of fkRes.rows) {
      lines.push(`ALTER TABLE ONLY "${table}" ADD CONSTRAINT "${fk.constraint_name}" FOREIGN KEY ("${fk.column_name}") REFERENCES "${fk.foreign_table_name}"("${fk.foreign_column_name}") ON DELETE CASCADE;`);
    }
  }

  // Restaurar role original
  lines.push(``);
  lines.push(`SET session_replication_role = 'origin';`);
  lines.push(``);

  // Escrever ficheiro
  fs.writeFileSync(outFile, lines.join('\n'), 'utf8');
  const sizeMB = (fs.statSync(outFile).size / 1024 / 1024).toFixed(2);

  client.release();
  await pool.end();

  console.log('');
  console.log('✅ BACKUP CONCLUÍDO!');
  console.log(`📁 Ficheiro: ${outFile}`);
  console.log(`📊 Tamanho : ${sizeMB} MB`);
  console.log(`📋 Tabelas : ${tables.length}`);
}

backup().catch(err => {
  console.error('❌ ERRO no backup:', err.message);
  process.exit(1);
});

