import re

with open('f:/New folder (3)/WhatsAppClone/index.html', 'r', encoding='utf-8') as f:
    content = f.read()

# Extract styles
style_match = re.search(r'<style>([\s\S]*?)</style>', content)
if style_match:
    css_content = style_match.group(1).strip()
    with open('f:/New folder (3)/WhatsAppClone/style.css', 'w', encoding='utf-8') as f:
        f.write(css_content)
    # Replace <style>...</style> with <link rel="stylesheet" href="style.css">
    content = content[:style_match.start()] + '<link rel="stylesheet" href="style.css">' + content[style_match.end():]

# Extract main script
script_match = re.search(r'<script>\s*(// --- Globals & State ---[\s\S]*?)</script>', content)
if script_match:
    js_content = script_match.group(1).strip()
    with open('f:/New folder (3)/WhatsAppClone/app.js', 'w', encoding='utf-8') as f:
        f.write(js_content)
    # Replace <script>...</script> with <script src="app.js"></script>
    content = content[:script_match.start()] + '<script src="app.js"></script>' + content[script_match.end():]

with open('f:/New folder (3)/WhatsAppClone/index.html', 'w', encoding='utf-8') as f:
    f.write(content)

print("Split completed successfully.")
