$ErrorActionPreference = "Stop"
$ProjectPath = "C:\Users\emanuele.gallo\Projects\MIO\google-drive-mcp"
Set-Location $ProjectPath

Write-Host "=== [1/6] git status ===" -ForegroundColor Cyan
git branch --show-current
git status --short

Write-Host "`n=== [2/6] npm install ===" -ForegroundColor Cyan
npm install --prefer-offline

Write-Host "`n=== [3/6] npm run build ===" -ForegroundColor Cyan
npm run build

Write-Host "`n=== [4/6] npm run typecheck ===" -ForegroundColor Cyan
npm run typecheck

Write-Host "`n=== [5/6] git add + commit ===" -ForegroundColor Cyan
git add -A
git commit -m "feat: add configurable timeout and retry for Google API calls

Add --api-timeout, --retry-max, --retry-base-delay CLI flags
Fallback to env vars GOOGLE_DRIVE_MCP_API_TIMEOUT, _RETRY_MAX, _RETRY_BASE_DELAY
Add exponential backoff retry on retryable errors (429/503/504/ETIMEDOUT)
Add return-on-partial-success for createGoogleDoc when batchUpdate fails after retries
Update README with new Runtime Configuration section

Closes timeout issues on large content createGoogleDoc calls via MCP clients."

Write-Host "`n=== [6/6] git push ===" -ForegroundColor Cyan
git push -u origin feat/configurable-timeout-and-retry

Write-Host "`n=== DONE! Branch pushed. ===" -ForegroundColor Green
Write-Host "Next: open PR at https://github.com/emaxlele/google-drive-mcp" -ForegroundColor Yellow
