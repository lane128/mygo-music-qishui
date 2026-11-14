# Qishui plugin for MyGo Music: Windows diagnostic report
#
# Reads local state only: system version, plugin files, whether the programs
# start, and the exit codes of the signer. It never reads login data, tokens,
# playlists or anything else from the account.
# Usage: powershell -NoProfile -ExecutionPolicy Bypass -File .\diagnose.ps1
# Paste the whole output into the issue.

[CmdletBinding()]
param(
  [string]$PluginDir = '',
  [int]$Seconds = 25
)

$ErrorActionPreference = 'Continue'

function Show([string]$name, $value) {
  Write-Output ('{0,-26} {1}' -f $name, [string]$value)
}

function Describe-File([string]$path) {
  if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { return 'missing' }
  $item = Get-Item -LiteralPath $path
  $machine = 'unreadable'
  try {
    $stream = [System.IO.File]::Open($path, [System.IO.FileMode]::Open, [System.IO.FileAccess]::Read, [System.IO.FileShare]::ReadWrite)
    try {
      $reader = New-Object System.IO.BinaryReader($stream)
      $stream.Position = 0x3c
      $offset = $reader.ReadInt32()
      $stream.Position = $offset
      if ($reader.ReadUInt32() -eq 0x00004550) {
        switch ($reader.ReadUInt16()) {
          0x8664 { $machine = 'x64' }
          0xaa64 { $machine = 'arm64' }
          0x14c  { $machine = 'x86' }
          default { $machine = 'other PE' }
        }
      } else {
        $machine = 'not PE'
      }
    } finally {
      $stream.Close()
    }
  } catch {
    $machine = 'unreadable'
  }
  return ('{0:N0} bytes, {1}' -f $item.Length, $machine)
}

function Describe-Asset([string]$path) {
  $text = Describe-File $path
  if ($text -eq 'missing') { return $text }
  try {
    $zone = Get-Item -LiteralPath $path -Stream Zone.Identifier -ErrorAction Stop
    if ($zone) { return ($text + ', downloaded-from-internet marker') }
  } catch { }
  return $text
}

function Quote-Arg([string]$value) {
  if ($value -match '[\s"]') { return ('"' + $value.Replace('"', '\"') + '"') }
  return $value
}

# Runs a program with the given request bytes on stdin. Returns exit code and
# the first lines it wrote to stderr.
function Invoke-Program([string]$exe, [string[]]$arguments, [byte[]]$inputBytes) {
  $psi = New-Object System.Diagnostics.ProcessStartInfo
  $psi.FileName = $exe
  $psi.WorkingDirectory = $temp
  $psi.UseShellExecute = $false
  $psi.CreateNoWindow = $true
  $psi.RedirectStandardInput = $true
  $psi.RedirectStandardOutput = $true
  $psi.RedirectStandardError = $true
  if ($arguments) {
    $joined = @()
    foreach ($argument in $arguments) { $joined += (Quote-Arg $argument) }
    $psi.Arguments = ($joined -join ' ')
  }
  $process = [System.Diagnostics.Process]::Start($psi)
  $outTask = $process.StandardOutput.ReadToEndAsync()
  $errTask = $process.StandardError.ReadToEndAsync()
  try {
    $process.StandardInput.BaseStream.Write($inputBytes, 0, $inputBytes.Length)
    $process.StandardInput.BaseStream.Flush()
    $process.StandardInput.Close()
  } catch {
    # The program stopped before taking the request; its exit code still tells us why.
  }
  $exited = $process.WaitForExit($Seconds * 1000)
  if (-not $exited) {
    try { $process.Kill() } catch { }
    return @{ Exit = 'timed out'; Error = '' }
  }
  $stderr = ''
  try { $stderr = $errTask.Result } catch { }
  $lines = @()
  foreach ($line in ($stderr -split "`r?`n")) {
    if ($line.Trim() -ne '') { $lines += $line.Trim() }
    if ($lines.Count -ge 3) { break }
  }
  return @{ Exit = $process.ExitCode; Error = ($lines -join ' | ') }
}

$appData = $env:APPDATA
if ([string]::IsNullOrEmpty($PluginDir)) {
  $PluginDir = Join-Path $appData 'MyGo Music\plugins\qishui-app-login'
}
$pluginData = Join-Path $appData 'MyGo Music\plugin-data\qishui-app-login'

Write-Output 'Qishui plugin diagnostic for MyGo Music'
Write-Output ('Time: ' + (Get-Date).ToString('yyyy-MM-dd HH:mm:ss'))
Write-Output ''

try {
  $os = Get-CimInstance Win32_OperatingSystem -ErrorAction Stop
  Show 'windows' ($os.Caption + ' ' + $os.Version)
} catch {
  Show 'windows' 'unknown'
}
$machine = $env:PROCESSOR_ARCHITEW6432
if ([string]::IsNullOrEmpty($machine)) { $machine = $env:PROCESSOR_ARCHITECTURE }
Show 'system architecture' $machine
Show 'powershell launched as' $env:PROCESSOR_ARCHITECTURE
Show '64-bit system' ([Environment]::Is64BitOperatingSystem)
Show 'powershell' ($PSVersionTable.PSVersion.ToString())

$mygoFound = $false
foreach ($process in (Get-Process -ErrorAction SilentlyContinue)) {
  try {
    $path = $process.Path
    if ($path -and ((Split-Path -Leaf $path) -like 'MyGo*')) {
      $version = ''
      try { $version = [System.Diagnostics.FileVersionInfo]::GetVersionInfo($path).FileVersion } catch { }
      Show 'mygo running' ($path + ' ' + $version)
      $mygoFound = $true
    }
  } catch { }
}
if (-not $mygoFound) { Show 'mygo running' 'not detected, start MyGo Music first' }

# Locate the plugin if the default directory isn't there.
if (-not (Test-Path -LiteralPath $PluginDir)) {
  $root = Join-Path $appData 'MyGo Music\plugins'
  if (Test-Path -LiteralPath $root) {
    foreach ($candidate in (Get-ChildItem -LiteralPath $root -Directory -ErrorAction SilentlyContinue)) {
      $manifest = Join-Path $candidate.FullName 'plugin.json'
      if (Test-Path -LiteralPath $manifest) {
        try {
          $json = Get-Content -LiteralPath $manifest -Raw -Encoding UTF8 | ConvertFrom-Json
          if ($json.id -eq 'qishui-app-login') { $PluginDir = $candidate.FullName }
        } catch { }
      }
    }
  }
}
Show 'plugin directory' $PluginDir

$manifestPath = Join-Path $PluginDir 'plugin.json'
if (Test-Path -LiteralPath $manifestPath) {
  try {
    $manifest = Get-Content -LiteralPath $manifestPath -Raw -Encoding UTF8 | ConvertFrom-Json
    Show 'plugin version' $manifest.version
    Show 'plugin id' $manifest.id
  } catch {
    Show 'plugin.json' 'unreadable'
  }
} else {
  Show 'plugin.json' 'missing'
}

$granted = Join-Path $pluginData 'granted.json'
if (Test-Path -LiteralPath $granted) {
  try {
    Show 'program permission' ((Get-Content -LiteralPath $granted -Raw).Trim())
  } catch {
    Show 'program permission' 'unreadable'
  }
} else {
  Show 'program permission' 'no granted.json, permission off'
}

$bin = Join-Path $PluginDir 'bin'
$helper = ''
$expectedArch = 'amd64'
if ($machine -eq 'ARM64') { $expectedArch = 'arm64' }
if ($machine -eq 'x86') { $expectedArch = '' }
$expectedHelper = Join-Path $bin ('qishui-helper-windows-' + $expectedArch + '.exe')
if ($expectedArch -eq '') { $expectedHelper = '' }

if (Test-Path -LiteralPath $bin) {
  $helpers = @(Get-ChildItem -LiteralPath $bin -Filter '*.exe' -ErrorAction SilentlyContinue)
  if ($helpers.Count -eq 0) { Show 'bin\*.exe' 'none' }
  foreach ($file in $helpers) {
    Show ('bin\' + $file.Name) (Describe-Asset $file.FullName)
    if ($expectedHelper -and ($file.FullName -eq $expectedHelper)) { $helper = $file.FullName }
  }
} else {
  Show 'bin' 'missing'
}
if ($expectedHelper) {
  Show 'expected helper' ((Split-Path -Leaf $expectedHelper) + ': ' + (Describe-Asset $expectedHelper))
}

$native = Join-Path $PluginDir 'runtime\native'
foreach ($name in @('qishui-sign.exe', 'windows-runner.exe', 'bdms.node', 'metasecml.dll')) {
  Show ('native\' + $name) (Describe-Asset (Join-Path $native $name))
}

try {
  $avs = @(Get-CimInstance -Namespace 'root/SecurityCenter2' -ClassName AntiVirusProduct -ErrorAction Stop)
  if ($avs.Count -eq 0) { Show 'antivirus' 'none reported' }
  foreach ($av in $avs) { Show 'antivirus' ($av.displayName + ' state ' + $av.productState) }
} catch {
  Show 'antivirus' 'not reported'
}

Write-Output ''
Write-Output 'Helper start test:'
if (-not $helper) {
  Show 'helper' 'skipped, expected file missing'
} else {
  try {
    $psi = New-Object System.Diagnostics.ProcessStartInfo
    $psi.FileName = $helper
    $psi.WorkingDirectory = $PluginDir
    $psi.UseShellExecute = $false
    $psi.CreateNoWindow = $true
    $psi.RedirectStandardInput = $true
    $psi.RedirectStandardOutput = $true
    $psi.RedirectStandardError = $true
    $process = [System.Diagnostics.Process]::Start($psi)
    $process.StandardInput.Close()
    if ($process.WaitForExit(2000)) {
      Show 'helper' ('started, exited with code ' + $process.ExitCode + ' (stdin was closed)')
    } else {
      Show 'helper' 'started and stayed up for 2 s'
      try { $process.Kill() } catch { }
    }
  } catch {
    Show 'helper' ('could not start: ' + $_.Exception.Message)
  }
}

# The plugin signs each request in qishui-sign.exe, normally inside the
# isolated launcher windows-runner.exe. This builds one harmless request
# (fake device id) and reports only exit codes and the fixed diagnostics.
$signer = Join-Path $native 'qishui-sign.exe'
$runner = Join-Path $native 'windows-runner.exe'
$tempRoot = $env:TEMP
if ([string]::IsNullOrEmpty($tempRoot)) { $tempRoot = [System.IO.Path]::GetTempPath() }
$temp = Join-Path $tempRoot ('qishui-diag-' + [System.IO.Path]::GetRandomFileName())
Write-Output ''
Write-Output 'Signer test:'
if ((Test-Path -LiteralPath $signer) -and (Test-Path -LiteralPath $runner)) {
  New-Item -ItemType Directory -Path $temp -Force | Out-Null
  Copy-Item -LiteralPath $signer -Destination (Join-Path $temp 'worker.exe') -Force
  foreach ($name in @('bdms.node', 'metasecml.dll')) {
    $source = Join-Path $native $name
    if (Test-Path -LiteralPath $source) { Copy-Item -LiteralPath $source -Destination (Join-Path $temp $name) -Force }
  }
  $did = '1000000000000001'
  $url = 'https://api.qishui.com/luna/pc/feed/mode?device_id=' + $did
  $headers = "user-agent`r`nLunaPC/3.7.0(452316191)`r`naccept`r`napplication/json"
  $request = New-Object System.IO.MemoryStream
  foreach ($field in @($did, $url, $headers)) {
    $bytes = [System.Text.Encoding]::UTF8.GetBytes($field)
    $length = [byte[]]@(
      [byte](($bytes.Length -shr 24) -band 255),
      [byte](($bytes.Length -shr 16) -band 255),
      [byte](($bytes.Length -shr 8) -band 255),
      [byte]($bytes.Length -band 255))
    $request.Write($length, 0, 4)
    $request.Write($bytes, 0, $bytes.Length)
  }
  $requestBytes = $request.ToArray()
  $request.Close()

  $direct = Invoke-Program (Join-Path $temp 'worker.exe') @() $requestBytes
  Show 'signer direct' ('exit ' + [string]$direct.Exit + ' ' + [string]$direct.Error)

  $arguments = @('--root', $temp, '--parent', [string]$PID, '--timeout-ms', '22000', '--', (Join-Path $temp 'worker.exe'))
  $isolated = Invoke-Program $runner $arguments $requestBytes
  Show 'signer isolated' ('exit ' + [string]$isolated.Exit + ' ' + [string]$isolated.Error)
} else {
  Show 'signer' 'skipped, signer or launcher missing'
}
if (Test-Path -LiteralPath $temp) {
  Remove-Item -LiteralPath $temp -Recurse -Force -ErrorAction SilentlyContinue
}

Write-Output ''
Write-Output 'Done. Copy everything above into the issue.'
Write-Output 'No account data, tokens or plugin storage was read.'
