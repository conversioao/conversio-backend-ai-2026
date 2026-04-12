import { query } from './db.js';

const newCores = [
    { name: 'BeautyAngo', style_id: 'CV-N01', description: 'Beleza & Cuidado Pessoal — Cosméticos, maquiagem, skincare, perfumes, produtos para pele negra', sort_order: 1 },
    { name: 'KidsAngo',   style_id: 'CV-N02', description: 'Moda & Vestuário Infantil — Roupa de criança, conjuntos, acessórios infantis, moda para bebés',  sort_order: 2 },
    { name: 'FitAngo',    style_id: 'CV-N03', description: 'Fitness & Bem-Estar — Suplementos, equipamentos de treino, produtos de saúde, activewear',          sort_order: 3 },
    { name: 'FoodAngo',   style_id: 'CV-N04', description: 'Alimentação & Bebidas Premium — Restaurantes, snacks, sumos naturais, produtos artesanais, delivery', sort_order: 4 },
    { name: 'TechAngo',   style_id: 'CV-N05', description: 'Tecnologia & Acessórios Tech — Smartphones, auscultadores, gadgets, acessórios electrónicos',        sort_order: 5 },
    { name: 'HomeAngo',   style_id: 'CV-N06', description: 'Casa & Decoração Moderna — Decoração, organização, iluminação, utensílios de cozinha, móveis',        sort_order: 6 },
    { name: 'HairAngo',   style_id: 'CV-N07', description: 'Cuidado Capilar Afro — Produtos capilares, extensões, perucas, acessórios de cabelo afro',             sort_order: 7 },
    { name: 'MamãAngo',   style_id: 'CV-N08', description: 'Produtos para Bebés & Maternidade — Fraldas, roupas de bebé, higiene infantil, brinquedos educativos', sort_order: 8 },
    { name: 'StyleAngo',  style_id: 'CV-N09', description: 'Moda & Acessórios Femininos — Bolsas, bijuteria, óculos, relógios, acessórios de moda',                sort_order: 9 },
    { name: 'CleanAngo',  style_id: 'CV-N10', description: 'Limpeza & Higiene Profissional — Produtos de limpeza premium, higiene doméstica, difusores, aromas',   sort_order: 10 }
];

async function insertCores() {
    try {
        console.log('Cleaning old Conversio Cores with style_id CV-N...');
        await query(`DELETE FROM models WHERE category = 'core' AND style_id LIKE 'CV-N%'`);

        console.log('Inserting 10 new Conversio Cores...');
        for (const core of newCores) {
            await query(
                `INSERT INTO models (name, type, category, style_id, description, is_active, credit_cost, sort_order)
                 VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
                [core.name, 'image', 'core', core.style_id, core.description, true, 0, core.sort_order]
            );
            console.log(`✓ Inserted ${core.name} (${core.style_id})`);
        }
        
        const verify = await query(`SELECT id, name, style_id FROM models WHERE category = 'core' AND style_id LIKE 'CV-N%' ORDER BY sort_order`);
        console.log('\nVerification — Inserted Cores:');
        console.table(verify.rows);
        console.log('\nAll 10 Cores inserted successfully!');
    } catch (err: any) {
        console.error('Error inserting cores:', err.message);
    } finally {
        process.exit(0);
    }
}

insertCores();
