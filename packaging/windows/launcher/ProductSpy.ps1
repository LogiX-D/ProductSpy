param(
    [switch]$Headless,
    [switch]$NoBrowser,
    [string]$DataRoot = (Join-Path $env:LOCALAPPDATA 'ProductSpy'),
    [string]$RuntimeRoot = '',
    [ValidateSet('Start', 'Status', 'Stop')][string]$Action = 'Start'
)

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object Text.UTF8Encoding($false)
$packageRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$DataRoot = [IO.Path]::GetFullPath($DataRoot)
if (-not $RuntimeRoot) { $RuntimeRoot = Join-Path $env:LOCALAPPDATA 'ProductSpy\runtime' }
$RuntimeRoot = [IO.Path]::GetFullPath($RuntimeRoot)
$stateFile = Join-Path $RuntimeRoot 'launcher-state.json'
$stopFile = Join-Path $RuntimeRoot 'stop-request.json'
$settingsDirectory = Join-Path $DataRoot 'settings'
$settingsFile = Join-Path $settingsDirectory 'ai-settings.protected.json'
$workspaceUrl = 'http://127.0.0.1:3000/'
$nodeProcess = $null
$launchId = [Guid]::NewGuid().ToString('N')
$ownsMutex = $false
$mutex = $null
$exitCode = 0

function Write-Result([string]$Event, [object]$Details) {
    $result = @{ event = $Event }
    foreach ($key in $Details.Keys) { $result[$key] = $Details[$key] }
    if ($Headless -or $Action -ne 'Start') { Write-Output ($result | ConvertTo-Json -Compress) }
}

function Write-JsonFile([string]$Path, [object]$Value) {
    $temporary = "$Path.$launchId.tmp"
    [IO.File]::WriteAllText($temporary, ($Value | ConvertTo-Json -Depth 5), (New-Object Text.UTF8Encoding($false)))
    Move-Item -LiteralPath $temporary -Destination $Path -Force
}

function Read-State {
    if (-not (Test-Path -LiteralPath $stateFile)) { return $null }
    try { return Get-Content -LiteralPath $stateFile -Raw | ConvertFrom-Json } catch { return $null }
}

function Open-Workspace { if (-not $NoBrowser) { Start-Process $workspaceUrl | Out-Null } }

function Test-Workspace {
    try {
        $response = Invoke-RestMethod -Uri ($workspaceUrl + 'api/status') -TimeoutSec 2
        return ($response.ok -eq $true -and $response.data.mode -in @('mock', 'real'))
    } catch { return $false }
}

function Test-PortInUse {
    # Refuse any listener on this port, including another loopback address.
    return (@([Net.NetworkInformation.IPGlobalProperties]::GetIPGlobalProperties().GetActiveTcpListeners() | Where-Object { $_.Port -eq 3000 }).Count -gt 0)
}

function Request-Stop([object]$State) {
    if ($null -eq $State -or -not $State.launchId) { return $false }
    Write-JsonFile $stopFile @{ launchId = $State.launchId }
    return $true
}

function Stop-OwnedService {
    if ($null -eq $nodeProcess) { return }
    $nodeProcess.Refresh()
    if (-not $nodeProcess.HasExited) {
        Write-JsonFile $stopFile @{ launchId = $launchId }
        if (-not $nodeProcess.WaitForExit(12000)) {
            # Only this process object, created by this launch, can be terminated.
            $nodeProcess.Kill()
            $nodeProcess.WaitForExit(3000) | Out-Null
        }
    }
}

function Read-AiSettings {
    Add-Type -AssemblyName System.Security
    $settings = @{ AI_MODE = 'auto'; AI_BASE_URL = 'https://api.openai.com/v1'; AI_MODEL = 'gpt-4o-mini'; AI_API_KEY = '' }
    if (Test-Path -LiteralPath $settingsFile) {
        try {
            $stored = Get-Content -LiteralPath $settingsFile -Raw | ConvertFrom-Json
            $plain = [Security.Cryptography.ProtectedData]::Unprotect([Convert]::FromBase64String($stored.protected), $null, [Security.Cryptography.DataProtectionScope]::CurrentUser)
            $decoded = [Text.Encoding]::UTF8.GetString($plain) | ConvertFrom-Json
            foreach ($name in @('AI_MODE', 'AI_BASE_URL', 'AI_MODEL', 'AI_API_KEY')) {
                if ($null -ne $decoded.$name) { $settings[$name] = [string]$decoded.$name }
            }
        } catch { throw '无法解密本机 AI 设置。请保留用户数据，在原 Windows 用户账户下重试，或移走 settings\ai-settings.protected.json 后重新配置。' }
    }
    return $settings
}

function Show-AiSettings {
    $current = Read-AiSettings
    $dialog = New-Object Windows.Forms.Form
    $dialog.Text = 'ProductSpy · AI 设置'
    $dialog.Size = New-Object Drawing.Size(470, 390)
    $dialog.StartPosition = 'CenterParent'
    $dialog.FormBorderStyle = 'FixedDialog'
    $dialog.MaximizeBox = $false
    $dialog.MinimizeBox = $false
    $fields = @{}
    $labels = @('模式（auto / mock / real）', 'API Base URL', '模型', 'API Key（仅保存在本机，使用 Windows 加密）')
    $names = @('AI_MODE', 'AI_BASE_URL', 'AI_MODEL', 'AI_API_KEY')
    for ($i = 0; $i -lt $names.Count; $i++) {
        $label = New-Object Windows.Forms.Label
        $label.Text = $labels[$i]
        $label.Location = New-Object Drawing.Point(18, (16 + $i * 62))
        $label.Size = New-Object Drawing.Size(420, 22)
        $input = New-Object Windows.Forms.TextBox
        $input.Location = New-Object Drawing.Point(18, (40 + $i * 62))
        $input.Size = New-Object Drawing.Size(420, 25)
        $input.Text = $current[$names[$i]]
        if ($names[$i] -eq 'AI_API_KEY') { $input.UseSystemPasswordChar = $true }
        $fields[$names[$i]] = $input
        $dialog.Controls.AddRange(@($label, $input))
    }
    $save = New-Object Windows.Forms.Button
    $save.Text = '保存，下次启动生效'
    $save.Location = New-Object Drawing.Point(240, 298)
    $save.Size = New-Object Drawing.Size(198, 34)
    $save.Add_Click({
        try {
            $value = @{}
            foreach ($name in $names) { $value[$name] = $fields[$name].Text.Trim() }
            if ($value.AI_MODE -notin @('auto', 'mock', 'real')) { throw '模式请输入 auto、mock 或 real。' }
            $baseUri = $null
            if (-not [Uri]::TryCreate($value.AI_BASE_URL, [UriKind]::Absolute, [ref]$baseUri) -or $baseUri.Scheme -notin @('http', 'https') -or $baseUri.UserInfo) { throw 'API Base URL 需要有效的 HTTP / HTTPS 地址，且不能包含密码。' }
            if ($baseUri.Query -or $baseUri.Fragment) { throw 'API Base URL 不能包含查询参数（?）或片段（#）。请填写 API 根地址，例如 https://api.openai.com/v1。' }
            if ($value.AI_MODE -eq 'real' -and -not $value.AI_API_KEY) { throw 'real 模式需要填写 API Key。未配置 Key 时，请选择 auto 或 mock 模式。' }
            if (-not $value.AI_MODEL) { throw '请填写模型名称。' }
            $plain = [Text.Encoding]::UTF8.GetBytes(($value | ConvertTo-Json -Compress))
            $encrypted = [Security.Cryptography.ProtectedData]::Protect($plain, $null, [Security.Cryptography.DataProtectionScope]::CurrentUser)
            Write-JsonFile $settingsFile @{ version = 1; protected = [Convert]::ToBase64String($encrypted) }
            [Windows.Forms.MessageBox]::Show('设置已使用当前 Windows 用户的 DPAPI 加密保存。退出 ProductSpy 后重新启动即可生效。', 'ProductSpy') | Out-Null
            $dialog.Close()
        } catch { [Windows.Forms.MessageBox]::Show($_.Exception.Message, '设置未保存') | Out-Null }
    })
    $dialog.Controls.Add($save)
    $dialog.ShowDialog() | Out-Null
    $dialog.Dispose()
}

try {
    if (-not $Headless) { Add-Type -AssemblyName System.Windows.Forms; Add-Type -AssemblyName System.Drawing }
    New-Item -ItemType Directory -Path $RuntimeRoot -Force | Out-Null
    $identity = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
    $mutex = New-Object Threading.Mutex($false, ('Local\ProductSpy.Workspace.' + $identity))

    if ($Action -eq 'Status') {
        $current = Read-State
        Write-Result 'status' @{ running = (Test-Workspace); state = $current }
    } elseif ($Action -eq 'Stop') {
        Write-Result 'stop-requested' @{ requested = (Request-Stop (Read-State)) }
    } else {
        try { $ownsMutex = $mutex.WaitOne(0) } catch [Threading.AbandonedMutexException] { $ownsMutex = $true }
        if (-not $ownsMutex) {
            $deadline = [DateTime]::UtcNow.AddSeconds(45)
            while ([DateTime]::UtcNow -lt $deadline -and -not (Test-Workspace)) { Start-Sleep -Milliseconds 250 }
            if (-not (Test-Workspace)) { throw '已有 ProductSpy 正在启动，但尚未就绪。请稍后再次双击，或查看已有控制窗口。' }
            Open-Workspace
            Write-Result 'already-running' @{ url = $workspaceUrl; state = (Read-State) }
        } else {
            if (Test-PortInUse) {
                $exitCode = 4
                throw '端口 3000 已被其他程序占用。请先退出占用该端口的程序，再启动 ProductSpy。启动器不会关闭其他程序。'
            }
            $nodePath = Join-Path $packageRoot 'runtime\node.exe'
            $serverPath = Join-Path $packageRoot 'app\apps\web\server.js'
            $wrapperPath = Join-Path $PSScriptRoot 'run-server.cjs'
            foreach ($file in @($nodePath, $serverPath, $wrapperPath)) { if (-not (Test-Path -LiteralPath $file -PathType Leaf)) { throw '安装包不完整。请完整解压 ZIP 后运行 ProductSpy.cmd。' } }
            New-Item -ItemType Directory -Path (Join-Path $DataRoot 'data') -Force | Out-Null
            New-Item -ItemType Directory -Path $settingsDirectory -Force | Out-Null
            $logs = Join-Path $DataRoot 'logs'
            New-Item -ItemType Directory -Path $logs -Force | Out-Null
            $settings = Read-AiSettings
            $environment = @{ NODE_ENV = 'production'; PORT = '3000'; HOSTNAME = '127.0.0.1'; NEXT_TELEMETRY_DISABLED = '1'; PRODUCTSPY_DATA_DIR = (Join-Path $DataRoot 'data'); PRODUCTSPY_STOP_FILE = $stopFile; PRODUCTSPY_LAUNCH_ID = $launchId; PRODUCTSPY_LAUNCHER_PID = [string]$PID }
            foreach ($name in $settings.Keys) { $environment[$name] = $settings[$name] }
            $oldEnvironment = @{}
            try {
                foreach ($name in $environment.Keys) {
                    $oldEnvironment[$name] = [Environment]::GetEnvironmentVariable($name, 'Process')
                    [Environment]::SetEnvironmentVariable($name, $environment[$name], 'Process')
                }
                $nodeProcess = Start-Process -FilePath $nodePath -ArgumentList @('"' + $wrapperPath + '"') -WorkingDirectory $packageRoot -WindowStyle Hidden -RedirectStandardOutput (Join-Path $logs 'workspace.stdout.log') -RedirectStandardError (Join-Path $logs 'workspace.stderr.log') -PassThru
            } finally {
                foreach ($name in $environment.Keys) { [Environment]::SetEnvironmentVariable($name, $oldEnvironment[$name], 'Process') }
            }
            $state = @{ launchId = $launchId; launcherPid = $PID; nodePid = $nodeProcess.Id; packageRoot = $packageRoot; dataRoot = $DataRoot; url = $workspaceUrl; startedAt = [DateTime]::UtcNow.ToString('o') }
            Write-JsonFile $stateFile $state
            $ready = $false
            $deadline = [DateTime]::UtcNow.AddSeconds(45)
            while ([DateTime]::UtcNow -lt $deadline) {
                $nodeProcess.Refresh()
                if ($nodeProcess.HasExited) { throw '工作台服务启动失败。请查看用户数据目录中的 logs\workspace.stderr.log。' }
                if (Test-Workspace) { $ready = $true; break }
                Start-Sleep -Milliseconds 250
            }
            if (-not $ready) { throw '工作台启动超时。请查看用户数据目录中的 logs 文件夹，然后退出并重新启动。' }
            Open-Workspace
            Write-Result 'ready' @{ url = $workspaceUrl; state = $state }
            if ($Headless) {
                while (-not $nodeProcess.HasExited) {
                    Start-Sleep -Milliseconds 250
                    $nodeProcess.Refresh()
                }
                Write-Result 'stopped' @{ nodePid = $nodeProcess.Id }
            } else {
                $form = New-Object Windows.Forms.Form
                $form.Text = 'ProductSpy'
                $form.Size = New-Object Drawing.Size(466, 345)
                $form.StartPosition = 'CenterScreen'
                $form.FormBorderStyle = 'FixedDialog'
                $form.MaximizeBox = $false
                $status = New-Object Windows.Forms.Label
                $status.Text = "工作台正在运行 · http://127.0.0.1:3000/`r`n关闭此窗口会安全停止本地服务。商品数据会保留。"
                $status.Location = New-Object Drawing.Point(18, 18)
                $status.Size = New-Object Drawing.Size(420, 52)
                $dataLabel = New-Object Windows.Forms.Label
                $dataLabel.Text = "用户数据：$DataRoot"
                $dataLabel.Location = New-Object Drawing.Point(18, 216)
                $dataLabel.Size = New-Object Drawing.Size(420, 40)
                $form.Controls.AddRange(@($status, $dataLabel))
                $actions = @(
                    @{ text = '打开工作台'; action = { Open-Workspace } },
                    @{ text = '打开插件文件夹'; action = { Start-Process explorer.exe -ArgumentList @('"' + (Join-Path $packageRoot 'extension') + '"') | Out-Null } },
                    @{ text = 'AI 设置'; action = { Show-AiSettings } },
                    @{ text = '打开用户数据'; action = { Start-Process explorer.exe -ArgumentList @('"' + $DataRoot + '"') | Out-Null } },
                    @{ text = '停止并退出'; action = { $form.Close() } }
                )
                for ($i = 0; $i -lt $actions.Count; $i++) {
                    $button = New-Object Windows.Forms.Button
                    $button.Text = $actions[$i].text
                    $button.Location = New-Object Drawing.Point((18 + ($i % 2) * 216), (80 + [Math]::Floor($i / 2) * 42))
                    $button.Size = New-Object Drawing.Size(204, 34)
                    $button.Add_Click($actions[$i].action)
                    $form.Controls.Add($button)
                }
                $timer = New-Object Windows.Forms.Timer
                $timer.Interval = 1000
                $timer.Add_Tick({
                    $nodeProcess.Refresh()
                    if ($nodeProcess.HasExited) {
                        $status.Text = '工作台服务已停止。商品数据已保留，可退出后重新启动。'
                        $timer.Stop()
                    }
                })
                $timer.Start()
                $form.ShowDialog() | Out-Null
                $timer.Dispose()
                $form.Dispose()
            }
        }
    }
} catch {
    if (-not $exitCode) { $exitCode = 1 }
    $message = $_.Exception.Message
    Write-Result 'error' @{ message = $message; exitCode = $exitCode }
    if (-not $Headless) { [Windows.Forms.MessageBox]::Show($message, 'ProductSpy 未能启动', 'OK', 'Error') | Out-Null }
} finally {
    if ($ownsMutex) {
        Stop-OwnedService
        $current = Read-State
        if ($current -and $current.launchId -eq $launchId) {
            Remove-Item -LiteralPath $stateFile -Force -ErrorAction SilentlyContinue
            Remove-Item -LiteralPath $stopFile -Force -ErrorAction SilentlyContinue
        }
        $mutex.ReleaseMutex()
    }
    if ($mutex) { $mutex.Dispose() }
}
exit $exitCode
