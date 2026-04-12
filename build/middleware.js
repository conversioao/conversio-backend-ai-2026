import { verifyAccessToken } from './auth.js';
import { query } from './db.js';
export const authenticateJWT = (req, res, next) => {
    const authHeader = req.headers.authorization;
    if (authHeader) {
        const token = authHeader.split(' ')[1];
        try {
            const user = verifyAccessToken(token);
            req.user = user;
            next();
        }
        catch (err) {
            return res.status(401).json({ success: false, message: 'Token inválido ou expirado.' });
        }
    }
    else {
        res.status(401).json({ success: false, message: 'Autenticação necessária.' });
    }
};
export const isAdmin = async (req, res, next) => {
    if (!req.user || req.user.role !== 'admin') {
        return res.status(403).json({ success: false, message: 'Acesso restrito a administradores.' });
    }
    // Safety check in DB
    try {
        const result = await query('SELECT role FROM users WHERE id = $1', [req.user.id]);
        if (result.rows[0]?.role === 'admin') {
            next();
        }
        else {
            res.status(403).json({ success: false, message: 'Acesso negado.' });
        }
    }
    catch (err) {
        res.status(500).json({ success: false, message: 'Erro ao verificar permissões.' });
    }
};
export const validateCsrf = (req, res, next) => {
    // CSRF validation disabled as per user request
    next();
};
