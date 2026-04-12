import fs from 'fs';

const data = fs.readFileSync('src/api.ts', 'utf8');
const lines = data.split('\n');
lines.forEach((line, i) => {
    if (line.includes('app.post') || line.includes('app.put') || line.includes('app.get')) {
        if (line.includes('admin') || line.includes('payment') || line.includes('invoice') || line.includes('billing')) {
            console.log(`Line ${i+1}: ${line.trim()}`);
        }
    }
});
