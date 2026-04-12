import { S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { getConfig } from './config.js';
async function getS3Client() {
    return new S3Client({
        region: await getConfig('storage_region', 'auto'),
        endpoint: await getConfig('storage_endpoint', 'https://s3.contabo.net'),
        credentials: {
            accessKeyId: await getConfig('storage_access_key', ''),
            secretAccessKey: await getConfig('storage_secret_key', ''),
        },
        forcePathStyle: true,
    });
}
export const provisionUserFolder = async (userId) => {
    const bucketName = await getConfig('storage_bucket', "kwikdocsao");
    const userPrefix = `users/${userId}/`;
    const subfolders = ['generations/Imagens/', 'generations/Videos/', 'generations/Audios/', 'profile/'];
    const s3 = await getS3Client();
    try {
        for (const sub of subfolders) {
            const command = new PutObjectCommand({
                Bucket: bucketName,
                Key: `${userPrefix}${sub}.keep`,
                Body: "",
            });
            await s3.send(command);
        }
        console.log(`[Storage] Hierarchical folders provisioned for user: ${userId}`);
        return userPrefix;
    }
    catch (error) {
        console.error("[Storage] Error provisioning user folder hierarchy:", error);
        throw error;
    }
};
export const getSignedS3UrlForKey = async (keyOrUrl, expiresIn = 3600) => {
    try {
        let key = keyOrUrl;
        const bucketName = await getConfig('storage_bucket', "kwikdocsao");
        const endpoint = await getConfig('storage_endpoint', "https://usc1.contabostorage.com");
        // If it's a full URL, check if it's from our S3
        if (key.startsWith('http://') || key.startsWith('https://')) {
            const isOurStorage = key.includes(endpoint.replace('https://', '').replace('http://', '')) || key.includes('contabostorage.com');
            if (!isOurStorage) {
                // External URL (like KIE.ai) - return as is
                return key;
            }
            try {
                const urlObj = new URL(key);
                let pathname = urlObj.pathname;
                // Contabo usually uses path-style: /bucketName/key
                const pathPrefix = `/${bucketName}/`;
                if (pathname.startsWith(pathPrefix)) {
                    key = pathname.substring(pathPrefix.length);
                }
                else if (pathname.startsWith('/')) {
                    key = pathname.substring(1);
                }
            }
            catch (e) {
                // Ignore URL parsing errors
            }
        }
        // Strip any query params if accidentally included
        if (key.includes('?')) {
            key = key.split('?')[0];
        }
        // Strip duplicate https:// inserted by previous bug
        if (key.includes('https://') || key.includes('https%3A//')) {
            const parts = key.split(/https:\/\/|https%3A\/\//);
            const possibleUrl = 'https://' + parts[1];
            try {
                const urlObj = new URL(possibleUrl);
                let pathname = urlObj.pathname;
                const pathPrefix = `/${bucketName}/`;
                if (pathname.startsWith(pathPrefix)) {
                    key = pathname.substring(pathPrefix.length);
                }
                else if (pathname.startsWith('/')) {
                    key = pathname.substring(1);
                }
            }
            catch (e) { }
        }
        key = decodeURIComponent(key);
        const s3 = await getS3Client();
        const command = new GetObjectCommand({ Bucket: bucketName, Key: key });
        return await getSignedUrl(s3, command, { expiresIn });
    }
    catch (error) {
        console.error("[Storage] Error generating signed URL:", error);
        throw error;
    }
};
export const uploadToTemp = async (fileBuffer, fileName, contentType) => {
    const bucketName = await getConfig('storage_bucket', "kwikdocsao");
    const endpoint = await getConfig('storage_endpoint', "https://usc1.contabostorage.com");
    const s3 = await getS3Client();
    // KIE.ai rejects .jfif extensions. Convert them to .jpeg.
    let safeFileName = fileName;
    if (safeFileName.toLowerCase().endsWith('.jfif')) {
        safeFileName = safeFileName.slice(0, -5) + '.jpeg';
    }
    if (contentType === 'image/jfif')
        contentType = 'image/jpeg';
    const key = `temp/${Date.now()}-${safeFileName}`;
    const command = new PutObjectCommand({
        Bucket: bucketName,
        Key: key,
        Body: fileBuffer,
        ContentType: contentType,
        ACL: 'public-read'
    });
    await s3.send(command);
    // Return a signed URL instead of a direct public URL to avoid 401 errors in n8n/OpenAI
    // 10 minutes is enough for n8n/OpenAI to download the file. Deletion is handled in the callback.
    return getSignedS3UrlForKey(key, 600);
};
export const uploadBufferToUserFolder = async (userId, category, fileBuffer, originalName, contentType = 'image/png') => {
    const bucketName = await getConfig('storage_bucket', "kwikdocsao");
    const endpoint = await getConfig('storage_endpoint', "https://usc1.contabostorage.com");
    let safeFileName = originalName;
    if (safeFileName.toLowerCase().endsWith('.jfif')) {
        safeFileName = safeFileName.slice(0, -5) + '.jpeg';
    }
    if (contentType === 'image/jfif')
        contentType = 'image/jpeg';
    const key = `users/${userId}/generations/${category}/${Date.now()}-${safeFileName}`;
    const s3 = await getS3Client();
    const command = new PutObjectCommand({
        Bucket: bucketName,
        Key: key,
        Body: fileBuffer,
        ContentType: contentType,
        ACL: 'public-read'
    });
    await s3.send(command);
    return `${endpoint}/${bucketName}/${key}`;
};
export const uploadTransactionFile = async (transactionId, type, fileBuffer, originalName, contentType) => {
    const bucketName = await getConfig('storage_bucket', "kwikdocsao");
    const endpoint = await getConfig('storage_endpoint', "https://usc1.contabostorage.com");
    const extension = originalName.split('.').pop();
    const key = `transactions/${transactionId}/${type}_${Date.now()}.${extension}`;
    const s3 = await getS3Client();
    const command = new PutObjectCommand({
        Bucket: bucketName,
        Key: key,
        Body: fileBuffer,
        ContentType: contentType,
        ACL: 'private'
    });
    await s3.send(command);
    return `${endpoint}/${bucketName}/${key}`;
};
export const deleteFile = async (key) => {
    const bucketName = await getConfig('storage_bucket', "kwikdocsao");
    const s3 = await getS3Client();
    try {
        const command = new DeleteObjectCommand({
            Bucket: bucketName,
            Key: key
        });
        await s3.send(command);
        console.log(`[Storage] Deleted: ${key}`);
    }
    catch (err) {
        console.error(`[Storage] Failed to delete ${key}:`, err.message);
    }
};
// Re-exporting for compatibility with existing code that might need it directly
export const getDynamicS3Client = getS3Client;
