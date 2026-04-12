import dotenv from 'dotenv';
import path from 'path';
dotenv.config({ path: path.join(process.cwd(), '.env') });
console.log('EVOLUTION_API_URL:', process.env.EVOLUTION_API_URL ? 'PRESENT' : 'MISSING');
console.log('EVOLUTION_API_KEY:', process.env.EVOLUTION_API_KEY ? 'PRESENT' : 'MISSING');
console.log('EVOLUTION_INSTANCE:', process.env.EVOLUTION_INSTANCE ? 'PRESENT' : 'MISSING');
import { sendWhatsAppMessage } from './services/whatsappService.js';
async function test() {
    console.log('Enviando mensagem de teste para 244950542896...');
    const result = await sendWhatsAppMessage('244950542896', 'Ola! Este e um teste do sistema de verificacao da Conversio.ai.');
    console.log('Resultado:', result);
}
test();
