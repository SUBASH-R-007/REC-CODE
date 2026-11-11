# Bring the local dev stack up and keep it up (Windows side).
#
#   powershell -ExecutionPolicy Bypass -File scripts/dev/stack-up.ps1
#   powershell -ExecutionPolicy Bypass -File scripts/dev/stack-up.ps1 -Stop
#
# WSL2 stops a distribution within seconds of its last session exiting —
# systemd being PID 1 does not prevent it — and that takes PostgreSQL, Redis
# and isolate down with it. Nothing on the Windows side notices until a
# request needs the database: the sign-in page then answers
# "Something went wrong. Please try again — if it keeps happening, quote
# reference …" and /api/health reports `"db":"down"`. Checking by hand hides
# the cause, because `wsl -d Ubuntu -- pg_isready` STARTS the distribution in
# order to run, and so always answers happily (docs/RUNBOOK.md §1.8).
#
# So this script holds one hidden `sleep infinity` session open. That session
# is the whole mechanism: with it, the distribution runs until Windows
# restarts or `wsl --shutdown`; without it, every service in WSL2 is
# available only while some other `wsl` command happens to be running.
#
# It then starts the three services and proves from WINDOWS — not from inside
# WSL2 — that the two ports the app dials actually answer, because that is
# the direction that breaks.

[CmdletBinding()]
param(
  [string] $Distro = "Ubuntu",
  [switch] $Stop
)

$ErrorActionPreference = "Stop"

function Get-Holder {
  param([string] $Distro)
  Get-CimInstance Win32_Process -Filter "Name = 'wsl.exe'" |
    Where-Object { $_.CommandLine -and $_.CommandLine -like "*sleep infinity*" -and $_.CommandLine -like "*$Distro*" }
}

function Test-Port {
  param([string] $Address, [int] $Port, [string] $Probe, [string] $Expect)
  $client = New-Object System.Net.Sockets.TcpClient
  try {
    $async = $client.BeginConnect($Address, $Port, $null, $null)
    if (-not $async.AsyncWaitHandle.WaitOne(4000)) { return "no answer (timed out)" }
    $client.EndConnect($async)
    if (-not $Probe) { return "ok" }
    $stream = $client.GetStream()
    $bytes = [Text.Encoding]::ASCII.GetBytes($Probe)
    $stream.Write($bytes, 0, $bytes.Length)
    $stream.Flush()
    $buffer = New-Object byte[] 128
    $stream.ReadTimeout = 4000
    $read = $stream.Read($buffer, 0, $buffer.Length)
    $reply = [Text.Encoding]::ASCII.GetString($buffer, 0, $read)
    if ($reply -like "*$Expect*") { return "ok" }
    return "answered, but not as $Expect"
  } catch {
    return $_.Exception.GetBaseException().Message
  } finally {
    $client.Close()
  }
}

if ($Stop) {
  $holders = Get-Holder -Distro $Distro
  if (-not $holders) { Write-Host "no holder is running for $Distro"; exit 0 }
  foreach ($holder in $holders) { Stop-Process -Id $holder.ProcessId -Force }
  Write-Host "stopped $(@($holders).Count) holder session(s); $Distro will shut itself down shortly"
  exit 0
}

if (Get-Holder -Distro $Distro) {
  Write-Host "holder: already running"
} else {
  Start-Process -FilePath "wsl.exe" -WindowStyle Hidden `
    -ArgumentList "-d", $Distro, "-u", "root", "--", "sleep", "infinity"
  Start-Sleep -Seconds 3
  if (Get-Holder -Distro $Distro) { Write-Host "holder: started" } else { throw "the holder session did not start" }
}

# redis-server binds 127.0.0.1 and, under mirrored networking, that is the
# HOST's loopback: a stale forwarder from a previous WSL2 session can still
# own the port for a few seconds after a restart, and systemd gives up after
# five tries in one second. reset-failed makes the retry possible.
wsl -d $Distro -u root -- bash -c "systemctl reset-failed postgresql redis-server isolate 2>/dev/null; systemctl start postgresql redis-server isolate" | Out-Null
$states = (wsl -d $Distro -u root -- bash -c "systemctl is-active postgresql redis-server isolate") -join " "
Write-Host "services: $($states.Trim())"

$checks = @(
  @{ Name = "postgres 127.0.0.1:5433"; Address = "127.0.0.1"; Port = 5433; Probe = $null; Expect = $null },
  @{ Name = "redis    127.0.0.1:6379"; Address = "127.0.0.1"; Port = 6379; Probe = "PING`r`n"; Expect = "PONG" }
)
$bad = 0
foreach ($check in $checks) {
  $result = Test-Port -Address $check.Address -Port $check.Port -Probe $check.Probe -Expect $check.Expect
  Write-Host "$($check.Name) -> $result"
  if ($result -ne "ok") { $bad++ }
}

if ($bad -gt 0) {
  Write-Host ""
  Write-Host "Not reachable from Windows. In order: run 'wsl --shutdown', run this script again,"
  Write-Host "and check %UserProfile%\.wslconfig has [wsl2] networkingMode=mirrored (RUNBOOK 1.1)."
  Write-Host "Use 127.0.0.1 in DATABASE_URL, never localhost: Windows resolves localhost to ::1"
  Write-Host "first and WSL2 serves only the IPv4 loopback."
  exit 1
}

Write-Host ""
Write-Host "Stack is up. Next: npx pnpm@9.15.9 dev   (then http://localhost:3000/api/health should say ok)"
