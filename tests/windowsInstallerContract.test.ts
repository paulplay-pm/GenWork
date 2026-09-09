import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, test } from 'vitest';

const repoFile = (path: string): string => readFileSync(resolve(process.cwd(), path), 'utf8');

const installerInclude = repoFile('scripts/nsis-installer.nsh');
const unpackScript = repoFile('scripts/unpack-runtime.cjs');
const installSection = repoFile(
  'node_modules/app-builder-lib/templates/nsis/installSection.nsh',
);
const extractTemplate = repoFile(
  'node_modules/app-builder-lib/templates/nsis/include/extractAppPackage.nsh',
);
const installerTemplate = repoFile(
  'node_modules/app-builder-lib/templates/nsis/include/installer.nsh',
);
const rootInstallerTemplate = repoFile(
  'node_modules/app-builder-lib/templates/nsis/installer.nsi',
);
const webPackageTemplate = repoFile(
  'node_modules/app-builder-lib/templates/nsis/include/webPackage.nsh',
);
const appBuilderPatch = repoFile('patches/app-builder-lib+24.13.3.patch');
const electronBuilderConfig = JSON.parse(repoFile('electron-builder.json')) as {
  nsis?: { deleteAppDataOnUninstall?: boolean };
};

const classifyFreshTarget = ({
  hasRegistrationEvidence,
  entries,
  enumerationError,
}: {
  hasRegistrationEvidence: boolean;
  entries?: string[];
  enumerationError?: number;
}): 'fresh-install' | 'possible-existing' => {
  if (hasRegistrationEvidence) {
    return 'possible-existing';
  }
  if (enumerationError !== undefined) {
    return enumerationError === 2 || enumerationError === 18
      ? 'fresh-install'
      : 'possible-existing';
  }
  return entries?.some((entry) => entry !== '.' && entry !== '..')
    ? 'possible-existing'
    : 'fresh-install';
};

describe('Windows installer hardening contracts', () => {
  test('releases the installer current-directory lock before the update rename', () => {
    const switchOutPath = installerInclude.indexOf('SetOutPath "$PLUGINSDIR"');
    const rename = installerInclude.indexOf(
      'MoveFileW(w "$genworkOldInstallOriginalPath", w "$genworkOldInstallBackupPath")',
    );

    expect(switchOutPath).toBeGreaterThan(-1);
    expect(rename).toBeGreaterThan(switchOutPath);
    expect(installerInclude).toContain('${IfNot} ${isUpdated}');
    expect(installerInclude).toContain('"install-location-mismatch"');
    expect(installerInclude).toContain('"ambiguous-dual-registration"');
    expect(installerInclude).toContain('phase=old-install-rename-attempt');
    expect(installerInclude).toContain('phase=old-install-rename-complete attempt_id=');
    expect(installerInclude).toContain('status=$genworkOldInstallRenameStatus');
    expect(installerInclude).not.toContain('phase=old-install-cleanup-complete');
  });

  test('captures shortcut state before rename and explicitly controls old uninstallers', () => {
    const shortcutProbe = installSection.indexOf('Var /GLOBAL keepShortcuts');
    const checkAppRunning = installSection.indexOf('!insertmacro CHECK_APP_RUNNING');
    const oldUninstaller = installSection.indexOf(
      '!insertmacro customUninstallOldVersion SHELL_CONTEXT',
    );
    const postUninstallHook = installSection.indexOf(
      '!insertmacro customAfterUninstallOldVersions',
    );
    const installFiles = installSection.indexOf('!insertmacro installApplicationFiles');

    expect(shortcutProbe).toBeGreaterThan(-1);
    expect(shortcutProbe).toBeLessThan(checkAppRunning);
    expect(oldUninstaller).toBeGreaterThan(checkAppRunning);
    expect(postUninstallHook).toBeGreaterThan(oldUninstaller);
    expect(postUninstallHook).toBeLessThan(installFiles);
    expect(installerInclude).toContain('phase=old-uninstaller-skipped');
    expect(installerInclude).toContain('phase=old-uninstaller-start');
    expect(installerInclude).toContain('phase=old-uninstaller-returned');
    expect(installerInclude).toContain('phase=old-uninstaller-complete');
  });

  test('applies and verifies Defender exclusion only after legacy uninstallers', () => {
    expect(installerInclude).toContain('!macro customAfterUninstallOldVersions');
    expect(installerInclude).toContain('point=post-old-uninstaller');
    expect(installerInclude).toContain(
      String.raw`$$target = $$env:GENWORK_INSTALL_ROOT;`,
    );
    expect(installerInclude).toContain('before_count=');
    expect(installerInclude).toContain('remove=');
    expect(installerInclude).toContain('after_count=');
    expect(installerInclude).toContain('Remove-MpPreference -ExclusionPath $$targets');
    expect(installerInclude).toContain('phase=old-install-cleanup-scheduled');
    expect(installerInclude).toContain(
      '${If} $genworkOldInstallRenameStatus == "committed"',
    );
    expect(installerInclude).toContain('target=exact-current-backup');
    expect(installerInclude).not.toContain('target_pattern=$INSTDIR.old');
    expect(installerInclude.indexOf('phase=old-install-cleanup-scheduled')).toBeGreaterThan(
      installerInclude.indexOf('phase=defender-exclusion-permanent-complete'),
    );
  });

  test('splits embedded package extraction, copying, cache, and size phases', () => {
    expect(extractTemplate).toContain('customAppPackageMaterializeStart');
    expect(extractTemplate).toContain('customAppPackageMaterializeEnd');
    expect(extractTemplate).toContain('customAppPackageExtractStart "staging" "${FILE}"');
    expect(extractTemplate).toContain('customAppPackageExtractEnd "staging" "unchecked"');
    expect(extractTemplate).toContain('customAppPackageCopyStart');
    expect(extractTemplate).toContain('customAppPackageCopyEnd "success"');
    expect(extractTemplate).toContain('customAppPackageCopyEnd "error"');
    expect(installerTemplate).toContain('customInstallerCacheCopyStart "installer"');
    expect(installerTemplate).toContain('customInstallerCacheCopyEnd "installer" "success"');
    expect(installerTemplate).toContain('customEstimatedSizeKnown');
    expect(installerTemplate).toContain('customEstimatedSizeScanStart');
    expect(installerTemplate).toContain('customEstimatedSizeScanEnd "$0"');

    const copyStart = extractTemplate.indexOf('customAppPackageCopyStart');
    const clearErrors = extractTemplate.indexOf('ClearErrors', copyStart);
    const copyFiles = extractTemplate.indexOf('CopyFiles /SILENT', copyStart);
    const copyErrorCheck = extractTemplate.indexOf('IfErrors CopyExtract7zaFailed', copyStart);
    expect(clearErrors).toBeGreaterThan(copyStart);
    expect(clearErrors).toBeLessThan(copyFiles);
    expect(copyFiles).toBeLessThan(copyErrorCheck);
  });

  test('rolls a renamed installation back before every controlled failure exit', () => {
    expect(installerInclude).toContain('Function genworkRollbackOldInstall');
    expect(installerInclude).toContain('phase=old-install-rollback-start');
    expect(installerInclude).toContain('phase=old-install-rollback-complete');
    expect(installerInclude).toContain('phase=old-install-commit-complete');
    expect(installerInclude).toContain('phase=skill-backup-failed-abort');
    expect(installerInclude).toContain('phase=skill-restore-failed');
    expect(installerInclude).toContain(
      'StrCmp $genworkOldInstallRollbackStatus "success"',
    );
    expect(installerInclude).toContain('!macro customBeforeInstallerQuit REASON');
    expect(rootInstallerTemplate).toContain('!define MUI_CUSTOMFUNCTION_ABORT');
    expect(rootInstallerTemplate).toContain('Function .onInstFailed');
    expect(extractTemplate).toContain(
      '!insertmacro customBeforeInstallerQuit "payload-copy-aborted"',
    );
    expect(webPackageTemplate).toContain(
      '!insertmacro customBeforeInstallerQuit "web-package-download-cancelled"',
    );

    const commit = installerInclude.indexOf('phase=old-install-commit-complete');
    const cleanup = installerInclude.indexOf('phase=old-install-cleanup-scheduled');
    expect(commit).toBeGreaterThan(-1);
    expect(cleanup).toBeGreaterThan(commit);
  });

  test('terminates the attempt after rename verification rollback', () => {
    const start = installerInclude.indexOf('OldInstallRenameVerificationFailed:');
    const end = installerInclude.indexOf('OldInstallRenameComplete:', start);
    const failure = installerInclude.slice(start, end);

    expect(failure).toContain(
      '!insertmacro customRollbackOldInstall "rename-verification-failed"',
    );
    expect(failure).toContain(
      'StrCmp $genworkOldInstallRollbackStatus "success" OldInstallRenameVerificationRestored',
    );
    expect(failure).toContain('outcome=recovery-required');
    expect(failure).toContain('outcome=restored');
    expect(failure).toContain('SetErrorLevel 3');
    expect(failure).toContain('SetErrorLevel 2');
    expect(failure.match(/^\s+Quit$/gm)).toHaveLength(2);
    expect(failure).not.toContain('Goto OldInstallRenameComplete');
  });

  test('classifies fresh installs before helpers and keeps existing-install fallbacks', () => {
    const checkStart = installerInclude.indexOf('!macro customCheckAppRunning');
    const checkEnd = installerInclude.indexOf('!macro customUninstallOldVersion', checkStart);
    const check = installerInclude.slice(checkStart, checkEnd);
    const preflight = check.indexOf('!insertmacro DetectFreshOrPossibleExisting');
    const sourceProbe = check.indexOf('phase=legacy-skills-source-preflight');
    const resolver = check.indexOf('!insertmacro ResolveTrustedPowerShell');
    const stop = check.indexOf('!insertmacro stopGenWorkProcesses');
    const backup = check.indexOf('phase=skill-backup-complete');

    expect(preflight).toBeGreaterThan(-1);
    expect(sourceProbe).toBeGreaterThan(preflight);
    expect(resolver).toBeGreaterThan(sourceProbe);
    expect(stop).toBeGreaterThan(resolver);
    expect(backup).toBeGreaterThan(stop);
    expect(check).toContain(
      'StrCmp $genworkInstallScenario "fresh-install" CustomCheckFreshInstall',
    );
    expect(check).toContain('phase=fresh-install-old-flow-skipped');
    expect(check).toContain('"legacy-not-applicable-fresh-install"');
    expect(check).toContain('"registered-install-missing"');
    expect(check).toContain('"install-location-mismatch"');
    expect(check).toContain('"ambiguous-dual-registration"');
  });

  test('re-kills processes on every stop round and logs survivors on failure', () => {
    const start = installerInclude.indexOf('!macro stopGenWorkProcesses');
    const end = installerInclude.indexOf('!macroend', start);
    const stopMacro = installerInclude.slice(start, end);

    // The kill must live inside the poll loop: a kill-once-then-observe gate
    // loses against slow teardown and respawned processes.
    const loop = stopMacro.indexOf('for ($$i = 0; $$i -lt 30; $$i++)');
    const emptyCheck = stopMacro.indexOf('if ($$procs.Count -eq 0) { exit 0 }');
    const rekill = stopMacro.indexOf(
      '$$procs | Stop-Process -Force -ErrorAction SilentlyContinue',
    );
    const sleep = stopMacro.indexOf('Start-Sleep -Milliseconds 500');
    expect(loop).toBeGreaterThan(-1);
    expect(emptyCheck).toBeGreaterThan(loop);
    expect(rekill).toBeGreaterThan(emptyCheck);
    expect(sleep).toBeGreaterThan(rekill);
    expect(stopMacro).toContain('exit 3');

    // Survivor dump runs only on the exit-3 verdict, receives its inputs via
    // the child environment, and always clears them afterwards.
    expect(stopMacro).toContain('StrCmp $R2 "3" 0 StopGenWorkProcessesLog');
    expect(stopMacro).toContain(
      String.raw`SetEnvironmentVariable(t "GENWORK_STOP_LOG_PATH", t "$APPDATA\GenWork\install-timing.log")`,
    );
    expect(stopMacro).toContain(
      'SetEnvironmentVariable(t "GENWORK_STOP_ATTEMPT_ID", t "$genworkInstallerAttemptId")',
    );
    expect(stopMacro).toContain('SetEnvironmentVariable(t "GENWORK_STOP_LOG_PATH", t "")');
    expect(stopMacro).toContain('SetEnvironmentVariable(t "GENWORK_STOP_ATTEMPT_ID", t "")');
    expect(stopMacro).toContain(
      'phase=process-stop-survivor attempt_id=$$env:GENWORK_STOP_ATTEMPT_ID',
    );
    expect(stopMacro).toContain('name=$$($$p.ProcessName) pid=$$($$p.Id) path=$$fp');
    expect(stopMacro).toContain('phase=process-stop-survivors-logged');
    expect(stopMacro).toContain('exit $$procs.Count');
  });

  test('treats only an enumerably empty target as fresh', () => {
    expect(
      classifyFreshTarget({ hasRegistrationEvidence: false, entries: [] }),
    ).toBe('fresh-install');
    expect(
      classifyFreshTarget({
        hasRegistrationEvidence: false,
        entries: ['.', '..'],
      }),
    ).toBe('fresh-install');
    expect(
      classifyFreshTarget({
        hasRegistrationEvidence: false,
        entries: ['.', '..', 'leftover'],
      }),
    ).toBe('possible-existing');
    expect(
      classifyFreshTarget({
        hasRegistrationEvidence: true,
        entries: [],
      }),
    ).toBe('possible-existing');
    expect(
      classifyFreshTarget({
        hasRegistrationEvidence: false,
        enumerationError: 2,
      }),
    ).toBe('fresh-install');
    expect(
      classifyFreshTarget({
        hasRegistrationEvidence: false,
        enumerationError: 18,
      }),
    ).toBe('fresh-install');
    expect(
      classifyFreshTarget({
        hasRegistrationEvidence: false,
        enumerationError: 5,
      }),
    ).toBe('possible-existing');

    const start = installerInclude.indexOf('!macro DetectFreshOrPossibleExisting');
    const end = installerInclude.indexOf('!macroend', start);
    const detector = installerInclude.slice(start, end);
    expect(detector).toContain('FindFirst $4 $5 "$INSTDIR\\*"');
    expect(detector).toContain('FindNext $4 $5');
    expect(detector).toContain('StrCmp $5 "."');
    expect(detector).toContain('StrCmp $5 ".."');
    expect(detector).toContain('IntCmp $6 2 GenworkInstallPreflightFresh');
    expect(detector).toContain('IntCmp $6 18 GenworkInstallPreflightFresh');
    expect(detector).not.toContain('IfFileExists "$INSTDIR\\*"');
    expect(detector).not.toContain('IfFileExists "$INSTDIR\\*.*"');
  });

  test('resolves PowerShell and tar only from trusted absolute system paths', () => {
    expect(installerInclude).toContain(
      String.raw`$WINDIR\Sysnative\WindowsPowerShell\v1.0\powershell.exe`,
    );
    expect(installerInclude).toContain(
      String.raw`$WINDIR\System32\WindowsPowerShell\v1.0\powershell.exe`,
    );
    expect(installerInclude).toContain(String.raw`$WINDIR\Sysnative\tar.exe`);
    expect(installerInclude).toContain(String.raw`$WINDIR\System32\tar.exe`);
    expect(installerInclude).toContain(
      String.raw`nsExec::ExecToLog '"$genworkTrustedTarPath"`,
    );
    expect(installerInclude).not.toMatch(
      /(?:nsExec::\w+|Exec)\s+['"][^'"\n]*\bpowershell(?:\.exe)?\b/i,
    );
    expect(installerInclude).not.toContain(String.raw`$SYSDIR\tar.exe`);

    const interpretedCommands = installerInclude
      .split('\n')
      .filter((line) => /(?:nsExec::\w+|Exec).*-Command/.test(line));
    expect(interpretedCommands.length).toBeGreaterThan(0);
    for (const command of interpretedCommands) {
      expect(command).toContain('$genworkTrustedPowerShellPath');
      expect(command).not.toMatch(/\$(?:INSTDIR|APPDATA|genworkOldInstall\w*)/);
    }
  });

  test('uses typed helper outcomes and a marker-backed ten-minute watchdog', () => {
    const watchdogStart = installerInclude.indexOf('GENWORK_WATCHDOG_MARKER_PATH');
    const watchdogEnd = installerInclude.indexOf('TarExtractVerify:', watchdogStart);
    const watchdog = installerInclude.slice(watchdogStart, watchdogEnd);

    expect(installerInclude).toContain('"process-start-blocked"');
    expect(installerInclude).toContain('"numeric-exit-code"');
    expect(installerInclude).toContain('"legacy-helper-launch-failed"');
    expect(watchdog).toContain('WaitForExit(600000)');
    expect(watchdog).toContain('WaitForExit(30000)');
    expect(watchdog).toContain('"process-timeout"');
    expect(watchdog).toContain('"process-termination-failed"');
    expect(watchdog).toContain('GENWORK_WATCHDOG_TIMEOUT');
    expect(watchdog).toContain('GENWORK_WATCHDOG_TERMINATION_FAILED');
    expect(watchdog).toContain('function Write-GenworkWatchdogMarker');
    expect(watchdog).toContain(
      'GENWORK_WATCHDOG_MARKER_WRITE_FAILED:',
    );
    expect(
      watchdog.match(/Set-Content -LiteralPath \$\$marker/g),
    ).toHaveLength(1);
    expect(watchdog.indexOf('StrCmp $R2 "error"')).toBeLessThan(
      watchdog.indexOf('IntCmp $R2 0'),
    );
    expect(watchdog).toContain(
      'StrCmp $R2 "126" TarExtractTerminationFailed',
    );
    expect(
      watchdog.indexOf('StrCmp $R2 "126" TarExtractTerminationFailed'),
    ).toBeLessThan(
      watchdog.indexOf(
        'StrCmp $R4 "process-termination-failed" TarExtractTerminationFailed',
      ),
    );
    expect(watchdog).toContain(
      'StrCmp $R4 "process-timeout" 0 TarExtractNumericResult',
    );
    expect(watchdog).toContain('StrCmp $R2 "124" TarExtractTimeout');

    // A null exit code consults the child's success sentinel before being
    // classified as invalid output (exit-code query is permanently broken by
    // some security tooling while the child itself succeeds). The marker
    // values below are PowerShell-escaped because the sentinel verdict is
    // deliberately absent from the NSIS StrCmp dispatch (exit 0 flows through
    // the numeric branch into TarExtractVerify).
    expect(watchdog).toContain(String.raw`\"exit-code-null-sentinel-ok\"`);
    expect(watchdog).toContain('Test-Path -LiteralPath $$sentinel');
    expect(
      watchdog.indexOf(String.raw`\"exit-code-null-sentinel-ok\"`),
    ).toBeLessThan(watchdog.indexOf(String.raw`\"output-validation-failed\"`));
  });

  test('rescues a null watchdog exit code with the extractor success sentinel', () => {
    // The Node extractor publishes the sentinel only after every expected
    // root directory verified, keeping it strictly stronger than exit 0.
    expect(unpackScript).toContain("'.unpack-runtime-ok'");
    expect(unpackScript).toContain('missingDirs === 0');
    expect(unpackScript).toContain('required resources missing after extraction');
    expect(unpackScript).toContain("name: 'openclaw-runtime-entry'");
    expect(unpackScript).toContain("name: 'skills-content'");
    expect(unpackScript).toContain("name: 'python-entry'");
    expect(unpackScript).toContain('phase=sentinel-written');
    expect(unpackScript).toContain('phase=sentinel-write-failed');
    expect(unpackScript.indexOf('phase=verify-missing')).toBeLessThan(
      unpackScript.indexOf("'.unpack-runtime-ok'"),
    );

    // A stale sentinel must never vouch for a new attempt, and a committed
    // install leaves no sentinel behind (pre-launch delete + success delete).
    const sentinelDelete = String.raw`Delete "$INSTDIR\resources\.unpack-runtime-ok"`;
    const preLaunchDelete = installerInclude.indexOf(sentinelDelete);
    expect(preLaunchDelete).toBeGreaterThan(-1);
    expect(preLaunchDelete).toBeLessThan(
      installerInclude.indexOf('GENWORK_WATCHDOG_MARKER_PATH'),
    );
    expect(
      installerInclude.match(/Delete "\$INSTDIR\\resources\\\.unpack-runtime-ok"/g),
    ).toHaveLength(2);

    // Exit 127 re-enters the on-disk verification when the sentinel exists
    // instead of aborting outright; the fatal path stays intact.
    const branchStart = installerInclude.indexOf('TarExtractOutputValidationFailed:');
    const branchEnd = installerInclude.indexOf('TarExtractNonZero:', branchStart);
    const branch = installerInclude.slice(branchStart, branchEnd);
    expect(branch).toContain(
      String.raw`IfFileExists "$INSTDIR\resources\.unpack-runtime-ok" 0 TarExtractOutputValidationFatal`,
    );
    expect(branch).toContain('phase=tar-extract-sentinel-rescue');
    expect(branch).toContain('Goto TarExtractVerify');
    expect(branch).toContain('reason=watchdog-output-validation-failed');
    expect(branch).toContain('will not commit a partial application');
  });

  test('requires OpenClaw, Skills, and Python before committing an installation', () => {
    const extractVerifyStart = installerInclude.indexOf('TarExtractVerify:');
    const extractVerifyEnd = installerInclude.indexOf('TarExtractProcessFailed:', extractVerifyStart);
    const extractVerify = installerInclude.slice(extractVerifyStart, extractVerifyEnd);
    expect(extractVerify).toContain('TarExtractVerifySkills:');
    expect(extractVerify).toContain(String.raw`resources\SKILLs\*.*`);
    expect(extractVerify).toContain(String.raw`resources\python-win\python.exe`);
    expect(extractVerify).toContain(String.raw`resources\python-win\python3.exe`);
    expect(extractVerify).toContain('TarExtractRequiredResourceMissing:');

    const prevalidateStart = installerInclude.indexOf('NewInstallPrevalidateSkills:');
    const prevalidateEnd = installerInclude.indexOf('NewInstallPrevalidateSucceeded:', prevalidateStart);
    const prevalidate = installerInclude.slice(prevalidateStart, prevalidateEnd);
    expect(prevalidate).toContain(String.raw`resources\SKILLs\*.*`);
    expect(prevalidate).toContain(String.raw`resources\python-win\python.exe`);
    expect(prevalidate).toContain(String.raw`resources\python-win\python3.exe`);
  });

  test('binds Skills backup and restore to the current attempt manifest', () => {
    expect(installerInclude).toContain('backup-manifest.json');
    expect(installerInclude).toContain('schemaVersion = 1');
    expect(installerInclude).toContain('attemptId = $$attempt');
    expect(installerInclude).toContain('source = $$src');
    expect(installerInclude).toContain('oldVersion = $$oldVer');
    expect(installerInclude).toContain('skills = @($$userSkills.Name');
    expect(installerInclude).toContain('directories = $$directories');
    expect(installerInclude).toContain('files = $$files');
    expect(installerInclude).toContain('statistics = [ordered]@{');
    expect(installerInclude).toContain('Get-FileHash -LiteralPath');
    expect(installerInclude).toContain('$$verified.validation.status = \\"verified\\"');
    expect(installerInclude).toContain(
      'StrCmp $genworkLegacySkillsStatus "legacy-backup-succeeded" 0 SkipSkillRestore',
    );
    expect(installerInclude).toContain('if ($$manifest.attemptId -ne $$attempt)');
    expect(installerInclude).toContain('if ($$manifest.source -ne $$source)');
    expect(installerInclude).toContain(
      String.raw`skills-backup\$genworkInstallerAttemptId`,
    );
    expect(installerInclude).not.toContain(String.raw`skills-backup\*.*`);

    const restoreStart = installerInclude.indexOf(
      'StrCmp $genworkLegacySkillsStatus "legacy-backup-succeeded" 0 SkipSkillRestore',
    );
    const restoreEnd = installerInclude.indexOf('SkipSkillRestore:', restoreStart);
    const restore = installerInclude.slice(restoreStart, restoreEnd);
    expect(restore).toContain(
      'IfFileExists "$APPDATA\\GenWork\\skills-backup\\$genworkInstallerAttemptId\\backup-manifest.json" SkillRestoreAttemptBackupReady',
    );
    expect(restore).toContain('"legacy-restore-backup-missing"');
    expect(restore).toContain('Write-Output (\\"name-conflict:\\"');
    expect(restore).toContain('exit 20');
    expect(restore).toContain('"legacy-restore-name-conflict"');
    expect(restore).toContain('phase=skill-restore-conflict-preserved');
    expect(restore).toContain('phase=skill-restore-degraded');
    expect(restore.indexOf('$$conflicts = @(')).toBeLessThan(
      restore.indexOf('Remove-Item -LiteralPath $$backup'),
    );
  });

  test('drives Skills backup state from helper exit codes, never stdout text', () => {
    const defines: Record<string, string> = {};
    for (const match of installerInclude.matchAll(
      /!define (GENWORK_SKILL_BACKUP_EXIT_\w+) "(\d+)"/g,
    )) {
      defines[match[1]] = match[2];
    }
    expect(defines).toEqual({
      GENWORK_SKILL_BACKUP_EXIT_VERIFIED: '0',
      GENWORK_SKILL_BACKUP_EXIT_INSPECT_FAILED: '10',
      GENWORK_SKILL_BACKUP_EXIT_COPY_FAILED: '11',
      GENWORK_SKILL_BACKUP_EXIT_VERIFY_FAILED: '12',
      GENWORK_SKILL_BACKUP_EXIT_NO_USER_SKILLS: '13',
    });
    expect(new Set(Object.values(defines)).size).toBe(Object.keys(defines).length);

    // The helper exits and the NSIS status mapping both use the named codes,
    // so the protocol has a single source of truth.
    for (const name of Object.keys(defines)) {
      expect(installerInclude).toContain(`exit \${${name}}`);
      expect(installerInclude).toContain(`StrCmp $R2 "\${${name}}"`);
    }

    // stdout must never drive control flow: ExecToStack returns the helper
    // output with its trailing CRLF, so an exact text comparison silently
    // fails (the 2026.7.23 spurious legacy-restore-backup-missing bug).
    expect(installerInclude).not.toMatch(/StrCmp \$1 "legacy-/);
  });

  test('re-checks the attempt manifest after a verified backup before replacing the old install', () => {
    const backupComplete = installerInclude.indexOf('phase=skill-backup-complete');
    const postcheck = installerInclude.indexOf(
      'IfFileExists "$APPDATA\\GenWork\\skills-backup\\$genworkInstallerAttemptId\\backup-manifest.json" SkillBackupValidated',
    );
    const postcheckLog = installerInclude.indexOf(
      'phase=skill-backup-manifest-postcheck-missing',
    );
    const failedAbort = installerInclude.indexOf('SkillBackupFailedAbort:');
    const swapStart = installerInclude.indexOf('phase=old-install-rename-start');

    expect(backupComplete).toBeGreaterThan(-1);
    expect(postcheck).toBeGreaterThan(backupComplete);
    expect(postcheck).toBeLessThan(swapStart);
    expect(postcheckLog).toBeGreaterThan(postcheck);
    expect(postcheckLog).toBeLessThan(failedAbort);
    // A missing manifest downgrades to the existing fail-closed abort path
    // while the old install is still intact.
    expect(installerInclude.slice(postcheck, failedAbort)).toContain(
      'StrCpy $genworkLegacySkillsStatus "legacy-backup-verify-failed"',
    );
  });

  test('isolates degraded restore outcomes from the name-conflict branch', () => {
    const failurePreserved = installerInclude.indexOf('SkillRestoreFailurePreserved:');
    const conflictLabel = installerInclude.indexOf(
      'SkillRestoreConflictPreserved:',
      failurePreserved,
    );
    expect(failurePreserved).toBeGreaterThan(-1);
    expect(conflictLabel).toBeGreaterThan(failurePreserved);
    const degraded = installerInclude.slice(failurePreserved, conflictLabel);

    // Both degraded paths end at the shared terminal label instead of
    // falling through into the conflict branch.
    expect(degraded.match(/Goto SkillRestoreValidated/g)).toHaveLength(2);
    const instructions = degraded
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0 && !line.startsWith(';'));
    expect(instructions[instructions.length - 1]).toBe('Goto SkillRestoreValidated');

    // Only restore exit code 20 may enter the conflict branch.
    expect(installerInclude).toContain('StrCmp $R2 "20" SkillRestoreConflictPreserved');
    expect(installerInclude.match(/SkillRestoreConflictPreserved/g)).toHaveLength(2);

    // The degraded dialog states exactly what survives: a missing backup is
    // reported as missing, a preserved backup with its on-disk path.
    expect(degraded).toContain('action=continue-with-attempt-backup-preserved');
    expect(degraded).toContain('action=continue-no-backup-found');
    expect(degraded).toContain(
      'The recovery backup was preserved at $APPDATA\\GenWork\\skills-backup\\$genworkInstallerAttemptId',
    );
    expect(degraded).not.toContain('was not deleted');
  });

  test('appends attempt-correlated logs and records conservative provenance', () => {
    const initStart = installerInclude.indexOf('!macro customInit');
    const initEnd = installerInclude.indexOf('!macroend', initStart);
    const init = installerInclude.slice(initStart, initEnd);
    expect(installerInclude).toContain(
      "System::Call 'ole32::CoCreateGuid(g .s)'",
    );
    expect(installerInclude).toContain('RequestExecutionLevel admin');
    expect(init).toContain('!insertmacro EnsureInstallerAttemptId');
    expect(init.indexOf('!insertmacro EnsureInstallerAttemptId')).toBeLessThan(
      init.indexOf('FileOpen $9'),
    );
    expect(init).toContain(
      'FileOpen $9 "$APPDATA\\GenWork\\install-timing.log" a',
    );
    expect(init).toContain('FileSeek $9 0 END');
    expect(init).not.toContain(
      'FileOpen $9 "$APPDATA\\GenWork\\install-timing.log" w',
    );
    expect(init).toContain('StrCpy $genworkInvocationSource "unknown"');
    expect(init).toContain('${If} ${isUpdated}');
    expect(init).toContain('${AndIf} ${isForceRun}');
    expect(init).toContain('StrCpy $genworkInvocationSource "app-update"');
    expect(init).toContain('launcher_fallback=$genworkLauncherFallback');

    const phaseWrites = installerInclude
      .split('\n')
      .filter((line) => /FileWrite .*phase=/.test(line));
    expect(phaseWrites.length).toBeGreaterThan(0);
    for (const phaseWrite of phaseWrites) {
      expect(phaseWrite).toContain('attempt_id=');
    }
  });

  test('prevalidates before registration and commits only in the standard finalize hook', () => {
    const installFiles = installSection.indexOf('!insertmacro installApplicationFiles');
    const prepare = installSection.indexOf(
      '!insertmacro customBeforeRegistryAddInstallInfo',
    );
    const registry = installSection.indexOf('!insertmacro registryAddInstallInfo');
    const shortcuts = installSection.indexOf('!insertmacro addStartMenuLink');
    const finalize = installSection.indexOf('!insertmacro customInstall', prepare + 1);
    const prepareMacro = installerInclude.indexOf(
      '!macro customBeforeRegistryAddInstallInfo',
    );
    const prevalidated = installerInclude.indexOf(
      'phase=new-install-prevalidated',
      prepareMacro,
    );
    const finalizeMacro = installerInclude.indexOf('!macro customInstall', prepareMacro + 1);
    const committed = installerInclude.indexOf(
      'phase=old-install-commit-complete',
      finalizeMacro,
    );

    expect(prepare).toBeGreaterThan(installFiles);
    expect(registry).toBeGreaterThan(prepare);
    expect(shortcuts).toBeGreaterThan(registry);
    expect(finalize).toBeGreaterThan(shortcuts);
    expect(prevalidated).toBeGreaterThan(prepareMacro);
    expect(prevalidated).toBeLessThan(finalizeMacro);
    expect(committed).toBeGreaterThan(finalizeMacro);
    expect(installerInclude).toContain(
      'StrCmp $genworkOldInstallRenameStatus "prevalidated" 0 GenworkRollbackDone',
    );
    expect(installerInclude).toContain('registration=not-written');
  });

  test('aborts failed extraction and never treats recovery artifacts as success', () => {
    const failure = installerInclude.slice(
      installerInclude.indexOf('TarExtractFailed:'),
      installerInclude.indexOf('TarExtractDone:'),
    );

    expect(failure).toContain(
      '!insertmacro customRollbackOldInstall "resource-extraction-failed"',
    );
    expect(failure).toContain('SetErrorLevel 3');
    expect(failure).toContain('Quit');
    expect(installerInclude).toContain(
      'IfFileExists "$INSTDIR\\resources\\openclaw-runtime\\gateway-bundle.mjs"',
    );
    expect(installerInclude).not.toContain('runtime-and-recovery-artifacts-missing');
    expect(installerInclude).not.toContain('retry the extraction automatically');
    expect(installerInclude.indexOf('TarExtractSucceeded:')).toBeLessThan(
      installerInclude.indexOf('Delete "$INSTDIR\\resources\\win-resources.tar"'),
    );
    expect(installerInclude).toContain('Recovery files (if any):');
    expect(installerInclude).not.toContain('Previous files (if staged):');
  });

  test('relaunches a verified old app only for interactive update intent', () => {
    const start = installerInclude.indexOf('Function genworkTryRelaunchOldApp');
    const end = installerInclude.indexOf('FunctionEnd', start);
    const relaunch = installerInclude.slice(start, end);

    expect(relaunch).toContain('${StdUtils.TestParameter} $0 "updated"');
    expect(relaunch).toContain('${StdUtils.TestParameter} $0 "force-run"');
    expect(relaunch).toContain('IfSilent 0 GenworkOldAppRelaunchInteractive');
    expect(relaunch).toContain(
      'StrCmp $genworkTargetProcessesStopStatus "success"',
    );
    expect(installerInclude).toContain(
      'StrCpy $genworkOldAppAsarPath "$INSTDIR\\resources\\app.asar"',
    );
    expect(relaunch).toContain('$genworkOldAppAsarPath');
    expect(relaunch).toContain('IntOp $1 $0 & 0x410');
    expect(relaunch).toContain(
      '${StdUtils.ExecShellAsUser} $0 "$genworkOldAppExecutablePath" "open" ""',
    );
    expect(relaunch).toContain('StrCmp $0 "0" GenworkOldAppRelaunchSucceeded');
    expect(relaunch).toContain('"old-app-relaunch-failed"');
    expect(installerInclude).toContain(
      'StrCmp $genworkOldInstallRollbackStatus "success" 0 GenworkRollbackDone',
    );
  });

  test('preserves userData on uninstall by default', () => {
    expect(electronBuilderConfig.nsis?.deleteAppDataOnUninstall).toBe(false);
  });

  test('persists every template hook in the version-pinned patch', () => {
    expect(appBuilderPatch).toContain('templates/nsis/installSection.nsh');
    expect(appBuilderPatch).toContain('templates/nsis/installer.nsi');
    expect(appBuilderPatch).toContain('templates/nsis/include/extractAppPackage.nsh');
    expect(appBuilderPatch).toContain('templates/nsis/include/installer.nsh');
    expect(appBuilderPatch).toContain('templates/nsis/include/webPackage.nsh');
    expect(appBuilderPatch).toContain('customAfterUninstallOldVersions');
    expect(appBuilderPatch).toContain('customBeforeRegistryAddInstallInfo');
    expect(appBuilderPatch).toContain('customAppPackageExtractStart');
    expect(appBuilderPatch).toContain('customInstallerCacheCopyStart');

    // Preserve the existing explicit web-package URL behavior while updating
    // the larger patch file.
    expect(appBuilderPatch).toContain('Computed URLs point at a directory');
    expect(appBuilderPatch).toContain('defines.APP_PACKAGE_URL_IS_INCOMPLETE = null;');
  });
});
