param([switch]$NoBrowser, [switch]$NoClipboard)
$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath $PSScriptRoot
$nodeCommand = Get-Command node.exe -ErrorAction SilentlyContinue
if (-not $nodeCommand) { throw '请先安装 Node.js 20.12 或更高版本。' }
$taskNode = $nodeCommand.Source
if (-not (Test-Path -LiteralPath (Join-Path $PSScriptRoot 'node_modules/playwright'))) {
  $taskNpm = Get-Command npm.cmd -ErrorAction Stop
  & $taskNpm.Source ci --ignore-scripts --no-audit --no-fund
  if ($LASTEXITCODE -ne 0) { throw '依赖安装失败，请检查网络。' }
}
$info = (& $taskNode server.mjs info | ConvertFrom-Json)
if ($LASTEXITCODE -ne 0 -or -not $info.url) { throw '配置读取失败。' }
$taskUrl = $info.url
$running = $false
try { $health = Invoke-RestMethod -Uri ($taskUrl + '/healthz') -TimeoutSec 2; $running = $health.service -eq 'muse-quota-probe' } catch {}
if (-not $running) {
  $taskStdout = Join-Path $info.data_dir 'service.stdout.log'
  $taskStderr = Join-Path $info.data_dir 'service.stderr.log'
  $process = Start-Process -FilePath $taskNode -ArgumentList 'server.mjs' -WorkingDirectory $PSScriptRoot -WindowStyle Hidden -RedirectStandardOutput $taskStdout -RedirectStandardError $taskStderr -PassThru
  for ($attempt = 0; $attempt -lt 40; $attempt++) {
    Start-Sleep -Milliseconds 250
    if ($process.HasExited) { throw '服务启动失败，请检查 data/service.stderr.log。' }
    try { $health = Invoke-RestMethod -Uri ($taskUrl + '/healthz') -TimeoutSec 1; if ($health.service -eq 'muse-quota-probe') { $running = $true; break } } catch {}
  }
  if (-not $running) { throw '服务未就绪，请检查端口是否已被占用。' }
  Set-Content -LiteralPath (Join-Path $info.data_dir 'service.pid') -Value $process.Id -Encoding ASCII
}
if (-not $NoClipboard) {
  $taskKey = (Get-Content -LiteralPath (Join-Path $info.data_dir 'admin-token.txt') -Raw).Trim()
  Set-Clipboard -Value $taskKey
  Write-Output '访问密钥已复制到剪贴板，请在面板里粘贴。'
}
Write-Output ('Muse 额度探针：' + $taskUrl)
if (-not $NoBrowser) { Start-Process $taskUrl }
