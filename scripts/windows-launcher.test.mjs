import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const windows = process.platform === 'win32';
const launcherSource = resolve('packaging/windows/launcher/ProductSpy.ps1');
const wrapperSource = resolve('packaging/windows/launcher/run-server.cjs');

async function waitForExit(child, completion, milliseconds = 4000) {
  let timer;
  try {
    return await Promise.race([
      completion,
      new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(new Error('Owned test service did not stop.')),
          milliseconds,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
    if (child.exitCode === null) {
      child.kill();
      await completion;
    }
  }
}

async function supervisorFixture({ parentPid, stopRequest }) {
  const directory = await mkdtemp(join(tmpdir(), 'productspy-supervisor-'));
  const launcherDirectory = join(directory, 'launcher');
  const serverDirectory = join(directory, 'app/apps/web');
  await mkdir(launcherDirectory);
  await mkdir(serverDirectory, { recursive: true });
  const wrapper = join(launcherDirectory, 'run-server.cjs');
  await copyFile(wrapperSource, wrapper);
  const stoppedFile = join(directory, 'stopped.txt');
  const readyFile = join(directory, 'ready.txt');
  await writeFile(
    join(serverDirectory, 'server.js'),
    `const fs = require('node:fs');
const timer = setInterval(() => {}, 1000);
process.on('SIGTERM', () => {
  fs.writeFileSync(process.env.PRODUCTSPY_TEST_STOPPED, 'graceful');
  clearInterval(timer);
});
fs.writeFileSync(process.env.PRODUCTSPY_TEST_READY, 'ready');
`,
  );
  const stopFile = join(directory, 'stop-request.json');
  if (stopRequest !== undefined) await writeFile(stopFile, stopRequest);
  const child = spawn(process.execPath, [wrapper], {
    windowsHide: true,
    stdio: 'ignore',
    env: {
      ...process.env,
      PRODUCTSPY_STOP_FILE: stopFile,
      PRODUCTSPY_LAUNCH_ID: 'owned-test-launch',
      PRODUCTSPY_LAUNCHER_PID: String(parentPid),
      PRODUCTSPY_TEST_STOPPED: stoppedFile,
      PRODUCTSPY_TEST_READY: readyFile,
    },
  });
  const completion = once(child, 'exit');
  return { directory, child, completion, stopFile, stoppedFile, readyFile };
}

async function destroyFixture(fixture) {
  if (fixture.child.exitCode === null) {
    fixture.child.kill();
    await fixture.completion;
  }
  const target = resolve(fixture.directory);
  assert(target.startsWith(`${resolve(tmpdir())}\\`) || target.startsWith(`${resolve(tmpdir())}/`));
  await rm(target, { recursive: true, force: true });
}

describe('Windows portable launcher lifecycle guards', () => {
  it.runIf(windows)(
    'stops an orphaned owned service even when its stop-request JSON is corrupt',
    async () => {
      const fixture = await supervisorFixture({ parentPid: 99_999_999, stopRequest: '{broken' });
      try {
        const [exitCode] = await waitForExit(fixture.child, fixture.completion);
        expect(exitCode).toBe(0);
        expect(await readFile(fixture.stoppedFile, 'utf8')).toBe('graceful');
      } finally {
        await destroyFixture(fixture);
      }
    },
  );

  it.runIf(windows)(
    'does not stop a live owner for corrupt or unrelated stop requests',
    async () => {
      const fixture = await supervisorFixture({ parentPid: process.pid, stopRequest: '{partial' });
      try {
        await new Promise((complete) => setTimeout(complete, 600));
        expect(fixture.child.exitCode).toBeNull();
        expect(await readFile(fixture.readyFile, 'utf8')).toBe('ready');
        await writeFile(fixture.stopFile, JSON.stringify({ launchId: 'another-launch' }));
        await new Promise((complete) => setTimeout(complete, 400));
        expect(fixture.child.exitCode).toBeNull();
        await writeFile(fixture.stopFile, JSON.stringify({ launchId: 'owned-test-launch' }));
        const [exitCode] = await waitForExit(fixture.child, fixture.completion);
        expect(exitCode).toBe(0);
        expect(await readFile(fixture.stoppedFile, 'utf8')).toBe('graceful');
      } finally {
        await destroyFixture(fixture);
      }
    },
  );

  it.runIf(windows)('stops an orphaned service without a stop file', async () => {
    const fixture = await supervisorFixture({ parentPid: 99_999_999 });
    try {
      const [exitCode] = await waitForExit(fixture.child, fixture.completion);
      expect(exitCode).toBe(0);
      expect(await readFile(fixture.stoppedFile, 'utf8')).toBe('graceful');
    } finally {
      await destroyFixture(fixture);
    }
  });

  it.runIf(windows).each(['original', 'auto-inherited'])(
    'checks real directory writability without changing existing data or ACLs (ACL: %s)',
    async (aclMode) => {
      const directory = await mkdtemp(join(tmpdir(), 'productspy-writable-'));
      const powershell = `
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object Text.UTF8Encoding($false)
$tokens = $null
$errors = $null
$ast = [Management.Automation.Language.Parser]::ParseFile($env:PRODUCTSPY_TEST_SOURCE, [ref]$tokens, [ref]$errors)
if ($errors.Count -gt 0) { throw 'Launcher parse failed' }
$guard = $ast.Find({param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq 'Assert-WritableDirectory'}, $true)
if (-not $guard) { throw 'Missing writable-directory guard' }
Invoke-Expression $guard.Extent.Text
$path = $env:PRODUCTSPY_TEST_DIRECTORY
$sentinel = Join-Path $path 'existing-product.txt'
[IO.File]::WriteAllText($sentinel, 'retain-existing-data')
if ($env:PRODUCTSPY_TEST_ACL_MODE -eq 'auto-inherited') {
  # Exercise an already canonicalized D:AI descriptor as well as Node's original D:.
  [IO.Directory]::SetAccessControl($path, [IO.Directory]::GetAccessControl($path))
}
$originalSddl = [IO.Directory]::GetAccessControl($path).GetSecurityDescriptorSddlForm([Security.AccessControl.AccessControlSections]::Access)
Assert-WritableDirectory $path '用户数据'
if ([IO.File]::ReadAllText($sentinel) -ne 'retain-existing-data') { throw 'Existing data changed' }
if ([IO.Directory]::GetAccessControl($path).GetSecurityDescriptorSddlForm([Security.AccessControl.AccessControlSections]::Access) -ne $originalSddl) { throw 'Writable-directory guard changed the original ACL' }
$acl = [IO.Directory]::GetAccessControl($path)
$sid = [Security.Principal.WindowsIdentity]::GetCurrent().User
$deny = New-Object Security.AccessControl.FileSystemAccessRule($sid, [Security.AccessControl.FileSystemRights]::CreateFiles, [Security.AccessControl.AccessControlType]::Deny)
$acl.AddAccessRule($deny)
try {
  [IO.Directory]::SetAccessControl($path, $acl)
  $deniedSddl = [IO.Directory]::GetAccessControl($path).GetSecurityDescriptorSddlForm([Security.AccessControl.AccessControlSections]::Access)
  $blocked = $false
  try { Assert-WritableDirectory $path '用户数据' } catch {
    $blocked = $_.Exception.Message.Contains('用户数据') -and $_.Exception.Message.Contains('无法写入') -and $_.Exception.Message.Contains($path)
  }
  if (-not $blocked) { throw 'Actual denied ACL must produce a clear writable-directory error' }
  if ([IO.File]::ReadAllText($sentinel) -ne 'retain-existing-data') { throw 'Existing data changed after failure' }
  if ([IO.Directory]::GetAccessControl($path).GetSecurityDescriptorSddlForm([Security.AccessControl.AccessControlSections]::Access) -ne $deniedSddl) { throw 'Writable-directory guard changed the denied ACL' }
} finally {
  # Match the portable fixture's exact restore: .NET adds AI to original D:
  # descriptors, while native DACL-only restoration does not preserve existing AI.
  $descriptor = New-Object Security.AccessControl.RawSecurityDescriptor($originalSddl)
  if (($descriptor.ControlFlags -band [Security.AccessControl.ControlFlags]::DiscretionaryAclAutoInherited) -ne 0) {
    $restoredAcl = [IO.Directory]::GetAccessControl($path)
    $restoredAcl.SetSecurityDescriptorSddlForm($originalSddl, [Security.AccessControl.AccessControlSections]::Access)
    [IO.Directory]::SetAccessControl($path, $restoredAcl)
  } else {
    Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices; public static class ProductSpyWritableFixtureDacl { [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)] [return: MarshalAs(UnmanagedType.Bool)] public static extern bool SetFileSecurity(string path, uint information, byte[] descriptor); }'
    $binary = New-Object byte[] $descriptor.BinaryLength
    $descriptor.GetBinaryForm($binary, 0)
    if (-not [ProductSpyWritableFixtureDacl]::SetFileSecurity($path, 4, $binary)) { throw (New-Object ComponentModel.Win32Exception([Runtime.InteropServices.Marshal]::GetLastWin32Error())) }
  }
}
if ([IO.Directory]::GetAccessControl($path).GetSecurityDescriptorSddlForm([Security.AccessControl.AccessControlSections]::Access) -ne $originalSddl) { throw 'The test must restore the original ACL' }
Assert-WritableDirectory $path '用户数据'
if ([IO.File]::ReadAllText($sentinel) -ne 'retain-existing-data') { throw 'Existing data changed after ACL restore' }
if (@(Get-ChildItem -LiteralPath $path -Filter '.productspy-write-*.tmp').Count -gt 0) { throw 'Probe residue remained' }
$occupied = Join-Path $path 'occupied-file'
[IO.File]::WriteAllText($occupied, 'preserve-file')
$blockedFile = $false
try { Assert-WritableDirectory $occupied '用户数据' } catch { $blockedFile = $_.Exception.Message.Contains('无法写入') }
if (-not $blockedFile -or [IO.File]::ReadAllText($occupied) -ne 'preserve-file') { throw 'A file occupying the directory must stay intact' }
'writable-directory-passed'
`;
      try {
        const result = execFileSync(
          'powershell.exe',
          ['-NoProfile', '-NonInteractive', '-Command', powershell],
          {
            encoding: 'utf8',
            timeout: 15000,
            windowsHide: true,
            env: {
              ...process.env,
              PRODUCTSPY_TEST_SOURCE: launcherSource,
              PRODUCTSPY_TEST_DIRECTORY: directory,
              PRODUCTSPY_TEST_ACL_MODE: aclMode,
            },
          },
        );
        expect(result.trim()).toBe('writable-directory-passed');
      } finally {
        const target = resolve(directory);
        assert(
          target.startsWith(`${resolve(tmpdir())}\\`) || target.startsWith(`${resolve(tmpdir())}/`),
        );
        await rm(target, { recursive: true, force: true });
      }
    },
  );

  it.runIf(windows)(
    'stops only its owned process when the control directory cannot receive a stop request',
    async () => {
      const directory = await mkdtemp(join(tmpdir(), 'productspy-stop-fallback-'));
      const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
        windowsHide: true,
        stdio: 'ignore',
      });
      const completion = once(child, 'exit');
      const powershell = `
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object Text.UTF8Encoding($false)
$tokens = $null
$errors = $null
$ast = [Management.Automation.Language.Parser]::ParseFile($env:PRODUCTSPY_TEST_SOURCE, [ref]$tokens, [ref]$errors)
if ($errors.Count -gt 0) { throw 'Launcher parse failed' }
foreach ($name in @('Write-Result', 'Write-JsonFile', 'Stop-OwnedService')) {
  $function = $ast.Find({param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq $name}, $true)
  if (-not $function) { throw 'Missing shutdown guard' }
  Invoke-Expression $function.Extent.Text
}
$Headless = $true
$Action = 'Start'
$launchId = 'owned-test-launch'
$stopFile = Join-Path $env:PRODUCTSPY_TEST_DIRECTORY 'missing-control/stop-request.json'
$nodeProcess = [Diagnostics.Process]::GetProcessById([int]$env:PRODUCTSPY_TEST_CHILD_PID)
Stop-OwnedService
$nodeProcess.Refresh()
if (-not $nodeProcess.HasExited) { throw 'Owned process survived shutdown failure' }
`;
      try {
        const result = execFileSync(
          'powershell.exe',
          ['-NoProfile', '-NonInteractive', '-Command', powershell],
          {
            encoding: 'utf8',
            timeout: 15000,
            windowsHide: true,
            env: {
              ...process.env,
              PRODUCTSPY_TEST_SOURCE: launcherSource,
              PRODUCTSPY_TEST_DIRECTORY: directory,
              PRODUCTSPY_TEST_CHILD_PID: String(child.pid),
            },
          },
        );
        const warning = JSON.parse(result.trim());
        expect(warning.event).toBe('stop-warning');
        expect(warning.message).toContain('本次启动的服务');
        await waitForExit(child, completion);
      } finally {
        if (child.exitCode === null) {
          child.kill();
          await completion;
        }
        const target = resolve(directory);
        assert(
          target.startsWith(`${resolve(tmpdir())}\\`) || target.startsWith(`${resolve(tmpdir())}/`),
        );
        await rm(target, { recursive: true, force: true });
      }
    },
  );
});
