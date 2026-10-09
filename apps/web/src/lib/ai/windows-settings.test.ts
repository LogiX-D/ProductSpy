import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const windows = process.platform === 'win32';
const launcher = resolve('packaging/windows/launcher/ProductSpy.ps1');
const source = `
$ErrorActionPreference = 'Stop'
$sourceFile = $env:PRODUCTSPY_TEST_SOURCE
$testDirectory = $env:PRODUCTSPY_TEST_DIRECTORY
$parseTokens = $null
$parseErrors = $null
$parsed = [Management.Automation.Language.Parser]::ParseFile($sourceFile, [ref]$parseTokens, [ref]$parseErrors)
if ($parseErrors.Count -gt 0) { throw 'Launcher parse failed' }
$function = $parsed.Find({param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq 'Read-AiSettings'}, $true)
Invoke-Expression $function.Extent.Text
$settingsFile = Join-Path $testDirectory 'ai-settings.protected.json'
if ($env:PRODUCTSPY_TEST_SCENARIO -ne 'empty') {
  Add-Type -AssemblyName System.Security
  $data = @{AI_MODE='mock';AI_BASE_URL='https://example.invalid/v1';AI_MODEL='old-model';AI_API_KEY='test-only-placeholder'}
  if ($env:PRODUCTSPY_TEST_SCENARIO -eq 'advanced') {
    $data.AI_RESPONSE_FORMAT='text';$data.AI_TOKEN_PARAMETER='max_completion_tokens';$data.AI_MAX_OUTPUT_TOKENS='3072';$data.AI_TIMEOUT_MS='120000';$data.AI_TEMPERATURE='0.2'
  }
  $plain = [Text.Encoding]::UTF8.GetBytes(($data | ConvertTo-Json -Compress))
  $encrypted = [Security.Cryptography.ProtectedData]::Protect($plain,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser)
  [IO.File]::WriteAllText($settingsFile,(@{version=1;protected=[Convert]::ToBase64String($encrypted)} | ConvertTo-Json -Compress))
}
$settings = Read-AiSettings
# Do not return even test Key contents through subprocess output.
$settings.Remove('AI_API_KEY')
$settings | ConvertTo-Json -Compress
`;
function readSettings(scenario: string): Record<string, string> {
  const directory = mkdtempSync(join(tmpdir(), 'productspy-ai-settings-'));
  try {
    return JSON.parse(
      execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', source], {
        encoding: 'utf8',
        timeout: 15000,
        windowsHide: true,
        env: {
          ...process.env,
          PRODUCTSPY_TEST_SOURCE: launcher,
          PRODUCTSPY_TEST_DIRECTORY: directory,
          PRODUCTSPY_TEST_SCENARIO: scenario,
        },
      }),
    ) as Record<string, string>;
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}
describe('Windows launcher AI settings remain encrypted and backward compatible', () => {
  it.runIf(windows)(
    'rejects remote HTTP in the actual launcher save guard without writing settings',
    () => {
      const guardSource = `
$ErrorActionPreference = 'Stop'
$tokens = $null
$errors = $null
$ast = [Management.Automation.Language.Parser]::ParseFile($env:PRODUCTSPY_TEST_SOURCE, [ref]$tokens, [ref]$errors)
if ($errors.Count -gt 0) { throw 'Launcher parse failed' }
$guard = $ast.Find({param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq 'Assert-AiBaseUrl'}, $true)
if (-not $guard) { throw 'Missing API address guard' }
Invoke-Expression $guard.Extent.Text
$accepted = @('https://api.example.com/v1', 'http://localhost:11434/v1', 'http://127.0.0.1:11434/v1', 'http://[::1]:11434/v1')
foreach ($url in $accepted) { Assert-AiBaseUrl $url | Out-Null }
$rejected = @('http://api.example.com/v1', 'http://192.168.1.10:8080/v1', 'http://localhost.example.com/v1', 'http://127.0.0.1.example.com/v1', 'http://127.0.0.2/v1', 'http://0.0.0.0/v1', 'http://[::ffff:127.0.0.1]/v1', 'http://localhost./v1')
foreach ($url in $rejected) {
  $blocked = $false
  try { Assert-AiBaseUrl $url | Out-Null } catch { $blocked = $_.Exception.Message.Contains('HTTPS') }
  if (-not $blocked) { throw 'Unsafe endpoint accepted or missing clear HTTPS error' }
}
$invalid = @('javascript:alert(1)', 'https://user:password@api.example.com/v1', 'https://api.example.com/v1?key=value', 'https://api.example.com/v1#fragment')
foreach ($url in $invalid) {
  $blocked = $false
  try { Assert-AiBaseUrl $url | Out-Null } catch { $blocked = $true }
  if (-not $blocked) { throw 'Malformed endpoint accepted' }
}
'guard-passed'
`;
      const result = execFileSync(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-Command', guardSource],
        {
          encoding: 'utf8',
          timeout: 15000,
          windowsHide: true,
          env: { ...process.env, PRODUCTSPY_TEST_SOURCE: launcher },
        },
      );
      expect(result.trim()).toBe('guard-passed');
    },
  );
  it.runIf(windows)('loads defaults without a Key or any external call', () => {
    const settings = readSettings('empty');
    expect(settings.AI_MODE).toBe('auto');
    expect(settings.AI_RESPONSE_FORMAT).toBe('json_object');
    expect(settings.AI_TEMPERATURE).toBe('omit');
    expect(settings.AI_MAX_OUTPUT_TOKENS).toBe('8192');
  });
  it.runIf(windows)('reads Phase 10/11 DPAPI settings and supplies compatibility defaults', () => {
    const settings = readSettings('old');
    expect(settings.AI_MODEL).toBe('old-model');
    expect(settings.AI_BASE_URL).toBe('https://example.invalid/v1');
    expect(settings.AI_TOKEN_PARAMETER).toBe('max_tokens');
    expect(settings.AI_TIMEOUT_MS).toBe('60000');
    expect(settings.AI_API_KEY).toBeUndefined();
  });
  it.runIf(windows)('decrypts and retains explicit advanced compatibility options', () => {
    const settings = readSettings('advanced');
    expect(settings.AI_RESPONSE_FORMAT).toBe('text');
    expect(settings.AI_TOKEN_PARAMETER).toBe('max_completion_tokens');
    expect(settings.AI_MAX_OUTPUT_TOKENS).toBe('3072');
    expect(settings.AI_TIMEOUT_MS).toBe('120000');
    expect(settings.AI_TEMPERATURE).toBe('0.2');
  });
});
