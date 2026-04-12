import axios from 'axios';
import dotenv from 'dotenv';
import { query } from '../db.js';
dotenv.config();
const EVOLUTION_API_URL = process.env.EVOLUTION_API_URL || '';
const EVOLUTION_API_KEY = process.env.EVOLUTION_API_KEY || '';
const EVOLUTION_INSTANCE = process.env.EVOLUTION_INSTANCE || '';
export const sendWhatsAppMessage = async (number, text, category = 'general', delayMs = 1200) => {
    if (!EVOLUTION_API_URL || !EVOLUTION_API_KEY || !EVOLUTION_INSTANCE) {
        console.error('Evolution API credentials missing');
        return { success: false, error: 'Configuração da API WhatsApp ausente' };
    }
    try {
        // Formatar o número (remover espaços, caracteres especiais e garantir o DDI)
        let formattedNumber = number.replace(/\D/g, '');
        if (!formattedNumber.startsWith('244') && formattedNumber.length === 9) {
            formattedNumber = '244' + formattedNumber;
        }
        const response = await axios.post(`${EVOLUTION_API_URL}/message/sendText/${EVOLUTION_INSTANCE}`, {
            number: formattedNumber,
            options: {
                delay: delayMs,
                presence: "composing",
                linkPreview: false
            },
            text: text
        }, {
            headers: {
                'Content-Type': 'application/json',
                'apikey': EVOLUTION_API_KEY
            }
        });
        await query(`INSERT INTO whatsapp_logs (recipient, type, content, status, error_details, category) VALUES ($1, $2, $3, $4, $5, $6)`, [formattedNumber, 'text', text, 'success', null, category]).catch(e => console.error('[WhatsApp Log Error]', e.message));
        return { success: true, data: response.data };
    }
    catch (error) {
        const errorMsg = error.response?.data?.message || error.message;
        console.error('Error sending WhatsApp message:', JSON.stringify(error.response?.data || error.message, null, 2));
        await query(`INSERT INTO whatsapp_logs (recipient, type, content, status, error_details, category) VALUES ($1, $2, $3, $4, $5, $6)`, [number, 'text', text, 'failed', errorMsg, category]).catch(e => console.error('[WhatsApp Log Error]', e.message));
        return {
            success: false,
            error: errorMsg
        };
    }
};
export const generateVerificationCode = () => {
    return Math.floor(100000 + Math.random() * 900000).toString();
};
export const sendWhatsAppDocument = async (number, documentUrl, fileName, caption, category = 'general') => {
    if (!EVOLUTION_API_URL || !EVOLUTION_API_KEY || !EVOLUTION_INSTANCE) {
        console.error('Evolution API credentials missing for document');
        return { success: false, error: 'Configuração da API WhatsApp ausente' };
    }
    try {
        let formattedNumber = number.replace(/\D/g, '');
        if (!formattedNumber.startsWith('244') && formattedNumber.length === 9) {
            formattedNumber = '244' + formattedNumber;
        }
        const data = {
            number: formattedNumber,
            options: {
                delay: 1200,
                presence: "composing",
                linkPreview: false
            },
            mediatype: "document",
            mimetype: "application/pdf",
            caption: caption || "",
            media: documentUrl,
            fileName: fileName
        };
        const response = await axios.post(`${EVOLUTION_API_URL}/message/sendMedia/${EVOLUTION_INSTANCE}`, data, {
            headers: {
                'Content-Type': 'application/json',
                'apikey': EVOLUTION_API_KEY
            }
        });
        await query(`INSERT INTO whatsapp_logs (recipient, type, content, status, error_details, category) VALUES ($1, $2, $3, $4, $5, $6)`, [formattedNumber, 'document', `File: ${fileName} | Caption: ${caption || ''}`, 'success', null, category]).catch(e => console.error('[WhatsApp Log Error]', e.message));
        return { success: true, data: response.data };
    }
    catch (error) {
        const errorMsg = error.response?.data?.message || error.message;
        console.error('Error sending WhatsApp document:', JSON.stringify(error.response?.data || error.message, null, 2));
        await query(`INSERT INTO whatsapp_logs (recipient, type, content, status, error_details, category) VALUES ($1, $2, $3, $4, $5, $6)`, [number, 'document', `File: ${fileName}`, 'failed', errorMsg, category]).catch(e => console.error('[WhatsApp Log Error]', e.message));
        return {
            success: false,
            error: errorMsg
        };
    }
};
export const sendWhatsAppVideo = async (number, videoUrl, caption, category = 'agent_action') => {
    if (!EVOLUTION_API_URL || !EVOLUTION_API_KEY || !EVOLUTION_INSTANCE) {
        console.error('Evolution API credentials missing for video');
        return { success: false, error: 'Configuração da API WhatsApp ausente' };
    }
    try {
        let formattedNumber = number.replace(/\D/g, '');
        if (!formattedNumber.startsWith('244') && formattedNumber.length === 9) {
            formattedNumber = '244' + formattedNumber;
        }
        const response = await axios.post(`${EVOLUTION_API_URL}/message/sendMedia/${EVOLUTION_INSTANCE}`, {
            number: formattedNumber,
            options: {
                delay: 1200,
                presence: "composing",
                linkPreview: false
            },
            mediatype: "video",
            mimetype: "video/mp4",
            caption: caption || "",
            media: videoUrl
        }, {
            headers: {
                'Content-Type': 'application/json',
                'apikey': EVOLUTION_API_KEY
            }
        });
        await query(`INSERT INTO whatsapp_logs (recipient, type, content, status, error_details, category) VALUES ($1, $2, $3, $4, $5, $6)`, [formattedNumber, 'video', `Video: ${videoUrl}`, 'success', null, category]).catch(e => console.error('[WhatsApp Log Error]', e.message));
        return { success: true, data: response.data };
    }
    catch (error) {
        const errorMsg = error.response?.data?.message || error.message;
        console.error('Error sending WhatsApp video:', errorMsg);
        return { success: false, error: errorMsg };
    }
};
export const sendWhatsAppImage = async (number, imageUrl, caption, category = 'agent_action') => {
    if (!EVOLUTION_API_URL || !EVOLUTION_API_KEY || !EVOLUTION_INSTANCE) {
        return { success: false, error: 'Configuração da API WhatsApp ausente' };
    }
    try {
        let formattedNumber = number.replace(/\D/g, '');
        if (!formattedNumber.startsWith('244') && formattedNumber.length === 9) {
            formattedNumber = '244' + formattedNumber;
        }
        const response = await axios.post(`${EVOLUTION_API_URL}/message/sendMedia/${EVOLUTION_INSTANCE}`, {
            number: formattedNumber,
            options: {
                delay: 1200,
                presence: "composing",
                linkPreview: false
            },
            mediatype: "image",
            mimetype: "image/jpeg",
            caption: caption || "",
            media: imageUrl
        }, {
            headers: {
                'Content-Type': 'application/json',
                'apikey': EVOLUTION_API_KEY
            }
        });
        await query(`INSERT INTO whatsapp_logs (recipient, type, content, status, error_details, category) VALUES ($1, $2, $3, $4, $5, $6)`, [formattedNumber, 'image', `Image: ${imageUrl}`, 'success', null, category]).catch(e => console.error('[WhatsApp Log Error]', e.message));
        return { success: true, data: response.data };
    }
    catch (error) {
        return { success: false, error: error.message };
    }
};
