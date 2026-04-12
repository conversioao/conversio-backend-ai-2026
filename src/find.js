import fs from 'fs';

const data = fs.readFileSync('src/api.ts', 'utf8');
const lines = data.split('\n');
lines.forEach((line, i) => {
    if (line.toLowerCase().includes('comprovativo') || line.toLowerCase().includes('invoice') || line.toLowerCase().includes('reject')) {
        console.log(`Line ${i+1}: ${line.trim()}`);
    }
});
