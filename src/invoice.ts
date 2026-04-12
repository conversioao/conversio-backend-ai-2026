import PDFDocument from 'pdfkit';
import { getDynamicS3Client } from './storage.js';
import { PutObjectCommand } from "@aws-sdk/client-s3";
import { getConfig } from './config.js';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export async function generateInvoicePDF(tx: any, user: any) {
    const beneficiaryName = await getConfig('financial_beneficiary_name', 'CONVERSIO AO');
    
    return new Promise<Buffer>((resolve, reject) => {
        const doc = new PDFDocument({ margin: 50, size: 'A4' });
        const buffers: Buffer[] = [];

        doc.on('data', buffers.push.bind(buffers));
        doc.on('end', () => resolve(Buffer.concat(buffers)));
        doc.on('error', reject);

        // Header Background Decor
        doc.rect(0, 0, 600, 160).fillColor('#0A0A0A').fill();
        
        // Logo
        try {
            // Try different possible paths for the logo
            const logoPaths = [
                path.join(__dirname, '../../public/logo.png'),
                path.join(__dirname, '../public/logo.png'),
                path.join(process.cwd(), 'public/logo.png')
            ];
            
            let logoLoaded = false;
            for (const p of logoPaths) {
                if (fs.existsSync(p)) {
                    doc.image(p, 50, 45, { width: 100 });
                    logoLoaded = true;
                    break;
                }
            }
            
            if (!logoLoaded) throw new Error('Logo not found');
        } catch (e) {
            doc.fontSize(24).font('Helvetica-Bold').fillColor('#FFB800').text('CONVERSIO', 50, 55);
        }

        // Invoice Title
        doc.fontSize(10).font('Helvetica-Bold').fillColor('#FFB800').text('FATURA / RECIBO', 400, 50, { align: 'right' });
        doc.fontSize(22).font('Helvetica-Bold').fillColor('#FFFFFF').text(`#INV-${(tx.id || 'N/A').toString().substring(0, 8).toUpperCase()}`, 400, 65, { align: 'right' });
        doc.fontSize(10).font('Helvetica').fillColor('#888888').text(`Emitido em: ${new Date().toLocaleDateString('pt-AO')}`, 400, 95, { align: 'right' });

        doc.moveDown(6);

        // Styling columns
        const startY = 185;
        
        // Company Details (Left)
        doc.fontSize(10).font('Helvetica-Bold').fillColor('#FFB800').text('EMISSOR', 50, startY);
        doc.fontSize(12).font('Helvetica-Bold').fillColor('#000000').text('CONVERSIO AI', 50, startY + 15);
        doc.fontSize(10).font('Helvetica').fillColor('#444444').text('Plataforma Digital de Inteligência Artificial', 50, startY + 30);
        doc.text('Luanda, Angola', 50, startY + 45);
        doc.text('E-mail: geral@conversio.ao', 50, startY + 60);

        // Customer Details (Right)
        doc.fontSize(10).font('Helvetica-Bold').fillColor('#FFB800').text('CLIENTE', 350, startY);
        doc.fontSize(12).font('Helvetica-Bold').fillColor('#000000').text((user.name || 'Cliente').toUpperCase(), 350, startY + 15);
        doc.fontSize(10).font('Helvetica').fillColor('#444444').text(user.whatsapp ? `WhatsApp: ${user.whatsapp}` : (user.email || ''), 350, startY + 30);
        doc.text(`Identificador: #${(user.id || 'N/A').toString().slice(-6).toUpperCase()}`, 350, startY + 45);

        doc.moveDown(5);

        // Table Header
        const tableTop = doc.y + 20;
        doc.rect(50, tableTop, 500, 30).fillColor('#F7F7F7').fill();
        doc.fontSize(9).font('Helvetica-Bold').fillColor('#666666');
        doc.text('DESCRIÇÃO DO SERVIÇO', 70, tableTop + 10);
        doc.text('MÉTODO', 320, tableTop + 10);
        doc.text('TOTAL', 450, tableTop + 10, { align: 'right' });

        // Table Content
        doc.fontSize(11).font('Helvetica-Bold').fillColor('#000000');
        const itemY = tableTop + 45;
        doc.text(tx.description || `Recarga de Créditos - Pacote ${tx.type || 'Standard'}`, 70, itemY, { width: 240 });
        doc.fontSize(10).font('Helvetica').fillColor('#444444').text(tx.payment_method || 'Pagamento Online', 320, itemY);
        doc.fontSize(12).font('Helvetica-Bold').fillColor('#000000').text(`${Number(tx.amount).toLocaleString('pt-AO')} ${tx.currency || 'Kz'}`, 450, itemY, { align: 'right' });

        // Separator Line
        doc.moveTo(50, itemY + 45).lineTo(550, itemY + 45).strokeColor('#EEEEEE').lineWidth(1).stroke();

        // Summary Calculations
        const totalY = itemY + 70;
        doc.fontSize(10).font('Helvetica').fillColor('#888888').text('Subtotal:', 350, totalY);
        doc.fontSize(10).font('Helvetica-Bold').fillColor('#000000').text(`${Number(tx.amount).toLocaleString('pt-AO')} ${tx.currency || 'Kz'}`, 450, totalY, { align: 'right' });
        
        doc.fontSize(10).font('Helvetica').fillColor('#888888').text('Créditos Adicionados:', 350, totalY + 20);
        doc.fontSize(10).font('Helvetica-Bold').fillColor('#FFB800').text(`${tx.credits} ⚡`, 450, totalY + 20, { align: 'right' });

        // Total Highlight Box
        doc.rect(350, totalY + 45, 200, 45).fillColor('#FFB800').fill();
        doc.fontSize(11).font('Helvetica-Bold').fillColor('#000000').text('MONTANTE TOTAL', 365, totalY + 60);
        doc.fontSize(15).font('Helvetica-Bold').text(`${Number(tx.amount).toLocaleString('pt-AO')} ${tx.currency || 'Kz'}`, 450, totalY + 60, { align: 'right' });

        // Payment Instructions for Transfers
        if (tx.payment_method === 'Transferência') {
            doc.moveDown(8);
            doc.fontSize(10).font('Helvetica-Bold').fillColor('#FFB800').text('DADOS PARA LIQUIDAÇÃO', 50);
            doc.fontSize(10).font('Helvetica').fillColor('#333333').text(`Beneficiário: ${beneficiaryName}`);
            doc.text('Por favor, carregue o comprovativo no seu painel para ativação imediata.');
        }

        // Final Footer Note
        doc.fontSize(8).font('Helvetica').fillColor('#999999').text('Conversio AI - Transformando Ideias em Visual Realidade.', 50, 760, { align: 'center', width: 500 });
        doc.text('Este documento serve como prova oficial de pagamento.', { align: 'center', width: 500 });

        doc.end();
    });
}

export async function uploadInvoiceToS3(pdfBuffer: Buffer, txId: string) {
    const bucketName = await getConfig('storage_bucket', "kwikdocsao");
    const key = `Invoices/INV-${txId}-${Date.now()}.pdf`;
    const endpoint = await getConfig('storage_endpoint', "https://s3.contabo.net");
    const s3 = await getDynamicS3Client();

    const command = new PutObjectCommand({
        Bucket: bucketName,
        Key: key,
        Body: pdfBuffer,
        ContentType: 'application/pdf',
        ACL: 'public-read'
    });

    await s3.send(command);
    return `${endpoint}/${bucketName}/${key}`;
}
