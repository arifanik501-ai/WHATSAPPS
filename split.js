const fs = require('fs');

let content = fs.readFileSync('f:/New folder (3)/WhatsAppClone/index.html', 'utf8');

// Extract styles
const styleMatch = content.match(/<style>([\s\S]*?)<\/style>/);
if (styleMatch) {
    fs.writeFileSync('f:/New folder (3)/WhatsAppClone/style.css', styleMatch[1].trim(), 'utf8');
    content = content.replace(styleMatch[0], '<link rel="stylesheet" href="style.css">');
}

// Extract main script
const scriptMatch = content.match(/<script>\s*(\/\/ --- Globals & State ---[\s\S]*?)<\/script>/);
if (scriptMatch) {
    fs.writeFileSync('f:/New folder (3)/WhatsAppClone/app.js', scriptMatch[1].trim(), 'utf8');
    content = content.replace(scriptMatch[0], '<script src="app.js"></script>');
}

fs.writeFileSync('f:/New folder (3)/WhatsAppClone/index.html', content, 'utf8');
console.log("Split completed successfully.");
