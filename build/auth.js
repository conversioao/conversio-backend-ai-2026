import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import crypto from 'crypto';
const SALT_ROUNDS = 10;
const ACCESS_TOKEN_EXPIRES = '1h';
const REFRESH_TOKEN_EXPIRES = '7d';
const JWT_SECRET = process.env.JWT_SECRET || 'default_secret_key';
const JWT_REFRESH_SECRET = process.env.JWT_REFRESH_SECRET || 'default_refresh_secret_key';
export const hashPassword = async (password) => {
    return bcrypt.hash(password, SALT_ROUNDS);
};
export const comparePasswords = async (password, hash) => {
    return bcrypt.compare(password, hash);
};
export const hashToken = (token) => {
    return crypto.createHash('sha256').update(token).digest('hex');
};
export const generateAccessToken = (payload) => {
    return jwt.sign(payload, JWT_SECRET, { expiresIn: ACCESS_TOKEN_EXPIRES });
};
export const generateRefreshToken = (userId, tokenId) => {
    return jwt.sign({ userId, tokenId }, JWT_REFRESH_SECRET, { expiresIn: '7d' });
};
export const verifyAccessToken = (token) => {
    return jwt.verify(token, JWT_SECRET);
};
export const verifyRefreshToken = (token) => {
    return jwt.verify(token, JWT_REFRESH_SECRET);
};
// For backward compatibility if needed, but we should migrate all to the new ones
export const generateToken = generateAccessToken;
export const verifyToken = verifyAccessToken;
