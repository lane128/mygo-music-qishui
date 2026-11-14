# Runs cmd.exe inside the same isolated launcher the plugin uses, to see which
# resources the sandbox allows. Reads nothing from the account.
# Usage: powershell -NoProfile -ExecutionPolicy Bypass -File .\probe.ps1
[CmdletBinding()]
param(
  [string]$PluginDir = (Join-Path $env:APPDATA 'MyGo Music\plugins\qishui-app-login'),
  [string]$CmdPath = (Join-Path $env:SystemRoot 'System32\cmd.exe')
)

$ErrorActionPreference = 'Continue'

$native = Join-Path $PluginDir 'runtime\native'
$runner = Join-Path $native 'windows-runner.exe'
if (-not (Test-Path -LiteralPath $runner)) { throw ('Missing ' + $runner) }
if (-not (Test-Path -LiteralPath $CmdPath)) { throw ('Missing ' + $CmdPath) }

$root = Join-Path $env:TEMP ('qishui-probe-' + [System.IO.Path]::GetRandomFileName())
New-Item -ItemType Directory -Path $root -Force | Out-Null
Copy-Item -LiteralPath $CmdPath -Destination (Join-Path $root 'probe.exe') -Force
$probe = Join-Path $root 'probe.exe'

function Quote-Arg([string]$value) {
  if ($value -match '[\s"]') { return ('"' + $value.Replace('"', '\"') + '"') }
  return $value
}

function Invoke-Probe([string]$name, [string]$command, [string]$watched) {
  $psi = New-Object System.Diagnostics.ProcessStartInfo
  $psi.FileName = $runner
  $psi.WorkingDirectory = $root
  $psi.UseShellExecute = $false
  $psi.CreateNoWindow = $true
  $psi.RedirectStandardInput = $true
  $psi.RedirectStandardOutput = $true
  $psi.RedirectStandardError = $true
  $arguments = @('--root', $root, '--parent', [string]$PID, '--timeout-ms', '22000', '--', $probe, '/c', $command)
  $quoted = @()
  foreach ($argument in $arguments) { $quoted += (Quote-Arg $argument) }
  $psi.Arguments = ($quoted -join ' ')
  try {
    $process = [System.Diagnostics.Process]::Start($psi)
  } catch {
    Write-Output ('{0,-12} could not start: {1}' -f $name, $_.Exception.Message)
    return
  }
  $process.StandardInput.Close()
  if (-not $process.WaitForExit(30000)) {
    try { $process.Kill() } catch { }
    Write-Output ('{0,-12} timed out' -f $name)
    return
  }
  $out = ''
  $err = ''
  try { $out = $process.StandardOutput.ReadToEnd().Trim() } catch { }
  try { $err = $process.StandardError.ReadToEnd().Trim() } catch { }
  $extra = ''
  if ($watched) {
    $path = Join-Path $root $watched
    if (Test-Path -LiteralPath $path) {
      try { $extra = ' file=[' + (Get-Content -LiteralPath $path -Raw).Trim() + ']' } catch { $extra = ' file=unreadable' }
    } else {
      $extra = ' file=missing'
    }
  }
  Write-Output ('{0,-12} exit={1} out=[{2}] err=[{3}]{4}' -f $name, $process.ExitCode, $out, $err, $extra)
}

Write-Output 'Sandbox probe: the same launcher the plugin uses'
Invoke-Probe 'stdio' 'echo probe' ''
Invoke-Probe 'nul-device' 'echo probe>NUL' ''
Invoke-Probe 'file-write' 'echo probe>probe.txt' 'probe.txt'
Remove-Item -LiteralPath $root -Recurse -Force -ErrorAction SilentlyContinue
Write-Output 'Done. Paste these three lines back.'
