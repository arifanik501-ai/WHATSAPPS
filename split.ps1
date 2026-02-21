$content = Get-Content -Raw "index.html"

$styleRegex = "(?s)<style>(.*?)<\/style>"
$scriptRegex = "(?s)<script>(\s*// --- Globals & State ---.*?)<\/script>"

if ($content -match $styleRegex) {
    $matches[1].Trim() | Set-Content "style.css" -Encoding UTF8
    $content = $content -replace "(?s)<style>.*?<\/style>", "<link rel=`"stylesheet`" href=`"style.css`">"
}

if ($content -match $scriptRegex) {
    $matches[1].Trim() | Set-Content "app.js" -Encoding UTF8
    $content = $content -replace "(?s)<script>\s*// --- Globals & State ---.*?<\/script>", "<script src=`"app.js`"></script>"
}

$content | Set-Content "index.html" -Encoding UTF8
Write-Host "Split completed"
