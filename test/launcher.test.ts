import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

test('project settings add codemode and route every callable tool through it', () => {
  const settings = JSON.parse(readFileSync(join(import.meta.dirname, '../.pi/settings.json'), 'utf8'));
  assert.deepEqual(settings.defaultTools, ['+codemode', '+ls', '+find', '+grep', '-bash', '-powershell']);
  assert.equal(settings.codemode.mode, 'only');
});

test('launcher starts pi with the plugin and runs sign-in commands without it', () => {
  const temporary = realpathSync(mkdtempSync(join(tmpdir(), 'arcpi-')));
  try {
    const source = join(import.meta.dirname, '..');
    const project = join(temporary, 'project with spaces');
    const extension = join(project, 'arcgis-rest/dev.pi/extensions/arcgis');
    mkdirSync(project);
    copyFileSync(join(source, 'arcpi'), join(project, 'arcpi'));
    // The real session module: `login|logout|status` must work from a bare checkout.
    cpSync(join(source, 'arcgis-rest/dev.pi/extensions/arcgis'), extension, { recursive: true });
    // .mjs lets the executable fixture work independently of package.json.
    const pi = join(temporary, 'pi.mjs');
    writeFileSync(pi, `#!/usr/bin/env node
console.log(JSON.stringify({ args: process.argv.slice(2), cwd: process.cwd(), sessions: process.env.ARCGIS_SESSION_DIR, artifactsDir: process.env.ARCPI_ARTIFACTS_DIR }));
process.exit(Number(process.env.TEST_EXIT || 0));
`, { mode: 0o755 });
    const env = {
      ...process.env, PI_BIN: pi,
      ARCGIS_PORTAL_URL: 'https://portal.example.com/portal', ARCGIS_CLIENT_ID: 'test-client',
      ARCGIS_SESSION_DIR: '/unused/global/sessions',
    };
    const run = (args: string[] = [], changes: Record<string, string> = {}) => spawnSync('bash', [join(project, 'arcpi'), ...args], {
      cwd: temporary, env: { ...env, ...changes }, encoding: 'utf8', timeout: 5000,
    });
    const artifacts = join(project, 'artifacts');
    mkdirSync(join(artifacts, 'nested'), { recursive: true });
    const oldArtifact = join(artifacts, 'nested/old map.html');
    const recentArtifact = join(artifacts, 'recent.geojson');
    const outsideFile = join(temporary, 'outside.txt');
    const cutoffPassed = new Date(Date.now() - 86430_000); // 24 hours + 30 seconds
    for (const path of [oldArtifact, recentArtifact, outsideFile]) writeFileSync(path, 'keep or expire');
    for (const path of [oldArtifact, outsideFile]) utimesSync(path, cutoffPassed, cutoffPassed);
    const recentTime = new Date(Date.now() - 23 * 3600_000);
    utimesSync(recentArtifact, recentTime, recentTime);
    symlinkSync(outsideFile, join(artifacts, 'external-file'));
    symlinkSync(temporary, join(artifacts, 'external-directory'));

    const result = run(['-p', 'Find maps with spaces', '--model', 'provider/model']);
    assert.equal(result.status, 0, result.stderr);
    assert.ok(existsSync(join(artifacts, '.arcpi-artifacts')), 'The default artifacts/ is adopted and marked');
    assert.equal(existsSync(oldArtifact), false, 'Expired nested artifact must be removed');
    assert.match(result.stderr, /^Deleted 1 file\(s\) in artifacts\/ older than 1 day\(s\)\.$/m, 'Cleanup reports one count line on stderr');
    assert.ok(existsSync(recentArtifact), 'Recent artifact must be preserved');
    assert.ok(existsSync(outsideFile), 'Cleanup must not follow artifact symlinks');
    const launched = JSON.parse(result.stdout);
    assert.equal(launched.cwd, project);
    assert.equal(launched.sessions, join(project, '.arcgis'), 'Logins are cached inside the project, not where the environment pointed');
    const expectedSources = [
      join(project, '.pi/APPEND_SYSTEM.md'), join(extension, 'index.ts'),
      join(project, 'arcgis-rest/skills'),
    ];
    assert.deepEqual(launched.args, [
      '--append-system-prompt', expectedSources[0],
      '--extension', expectedSources[1],
      '--skill', expectedSources[2], '-p', 'Find maps with spaces', '--model', 'provider/model',
    ]);
    assert.equal(run([], { TEST_EXIT: '17' }).status, 17);
    const local = run(['-p', 'Show local wells'], { ARCGIS_PORTAL_URL: '', ARCGIS_CLIENT_ID: '' });
    assert.equal(local.status, 0, local.stderr);
    assert.deepEqual(JSON.parse(local.stdout).args.slice(-2), ['-p', 'Show local wells'], 'local-only sessions need no portal configuration');
    for (const key of ['ARCGIS_PORTAL_URL', 'ARCGIS_CLIENT_ID']) {
      assert.equal(run([], { [key]: '' }).status, 0, 'a partial portal configuration does not block local work');
      for (const command of ['login', 'logout', 'status']) {
        const missing = run([command], { [key]: '' });
        assert.notEqual(missing.status, 0);
        assert.ok(missing.stderr.includes(key));
      }
    }
    assert.notEqual(run([], { PI_BIN: '/missing/pi' }).status, 0);
    // Values following the resource flags, in launch order.
    const sources = (args: string[]) => args.filter((_, i) => i > 0 && ['--append-system-prompt', '--extension', '--skill'].includes(args[i - 1]));
    const relativePaths = run(['-p', 'Use relative paths'], { PI_BIN: './pi.mjs' });
    assert.equal(relativePaths.status, 0, relativePaths.stderr);
    assert.deepEqual(sources(JSON.parse(relativePaths.stdout).args), expectedSources);

    // Sign-in commands run the TypeScript session module with Node: no pi.
    writeFileSync(oldArtifact, 'expired again');
    utimesSync(oldArtifact, cutoffPassed, cutoffPassed);
    const status = run(['status'], { PI_BIN: '/missing/pi' });
    assert.equal(status.status, 0, status.stderr);
    assert.equal(existsSync(oldArtifact), false, 'Sign-in commands also clean old artifacts');
    const session = JSON.parse(status.stdout);
    assert.deepEqual([session.portal, session.signed_in], [env.ARCGIS_PORTAL_URL, false]);
    assert.ok(session.session_file.startsWith(join(project, '.arcgis/')));
    const otherPortal = JSON.parse(run(['status'], { ARCGIS_PORTAL_URL: 'https://other.example.com' }).stdout);
    const otherClient = JSON.parse(run(['status'], { ARCGIS_CLIENT_ID: 'other-client' }).stdout);
    assert.equal(new Set([session, otherPortal, otherClient].map((each) => each.session_file)).size, 3, 'Each portal/client pair has its own profile');
    assert.equal(run(['logout']).stdout.trim(), 'Signed out.');
    assert.equal(existsSync(join(project, '.arcgis')), false, 'Reading the status or signing out stores nothing');

    // The age limit is configurable in whole days; nothing is deleted on a bad value.
    const twoDaysPassed = new Date(Date.now() - 2 * 86400_000 - 30_000);
    writeFileSync(oldArtifact, 'two days old');
    utimesSync(oldArtifact, twoDaysPassed, twoDaysPassed);
    utimesSync(recentArtifact, cutoffPassed, cutoffPassed);
    for (const days of ['0', '1.5', 'x', '100000', '768614336404564651']) {
      const invalid = run([], { ARCPI_ARTIFACTS_MAX_AGE_DAYS: days });
      assert.notEqual(invalid.status, 0);
      assert.ok(invalid.stderr.includes('ARCPI_ARTIFACTS_MAX_AGE_DAYS'));
    }
    assert.ok(existsSync(oldArtifact) && existsSync(recentArtifact), 'An invalid age deletes nothing');
    assert.equal(run([], { ARCPI_ARTIFACTS_MAX_AGE_DAYS: '2' }).status, 0);
    assert.equal(existsSync(oldArtifact), false, 'Artifacts older than the configured age are removed');
    assert.ok(existsSync(recentArtifact), 'Artifacts younger than the configured age are kept');

    // Another artifacts folder: cleaned instead of artifacts/, announced to pi, passed on to the extension.
    const created = run([], { ARCPI_ARTIFACTS_DIR: 'fresh' });
    assert.equal(created.status, 0, created.stderr);
    assert.ok(existsSync(join(project, 'fresh/.arcpi-artifacts')), 'A new artifacts folder is created and marked');
    const results = join(project, 'results');
    mkdirSync(results);
    const oldResult = join(results, 'old.geojson');
    writeFileSync(oldResult, 'expired');
    utimesSync(oldResult, twoDaysPassed, twoDaysPassed);
    writeFileSync(oldArtifact, 'not the artifacts folder now');
    utimesSync(oldArtifact, twoDaysPassed, twoDaysPassed);
    const unmarked = run([], { ARCPI_ARTIFACTS_DIR: 'results' });
    assert.notEqual(unmarked.status, 0, 'An existing folder arcpi did not create is refused');
    assert.match(unmarked.stderr, /results\/ exists but arcpi did not create it/);
    assert.ok(existsSync(oldResult), 'Nothing is deleted in a folder arcpi did not create');
    writeFileSync(join(results, '.arcpi-artifacts'), '');
    utimesSync(join(results, '.arcpi-artifacts'), twoDaysPassed, twoDaysPassed);
    const custom = run(['-p', 'Map it'], { ARCPI_ARTIFACTS_DIR: 'results' });
    assert.equal(custom.status, 0, custom.stderr);
    assert.equal(existsSync(oldResult), false, 'The configured folder is cleaned');
    assert.ok(existsSync(join(results, '.arcpi-artifacts')), 'Cleanup keeps the marker, however old');
    assert.ok(existsSync(oldArtifact), 'artifacts/ is left alone when another folder is configured');
    assert.match(custom.stderr, /in results\/ older than/);
    const customArgs = JSON.parse(custom.stdout).args;
    assert.deepEqual(customArgs.slice(0, 4), [
      '--append-system-prompt', expectedSources[0],
      '--append-system-prompt', 'Generated files go in results/: read every artifacts/ in the skills and tool descriptions as results/.',
    ]);
    assert.equal(JSON.parse(custom.stdout).artifactsDir, 'results', 'pi and the extension see the folder name');
    for (const name of ['.git', '.arcgis', 'test', 'arcgis-rest', 'mappi', 'tasks', 'video', 'a/b', '..', '/tmp']) {
      const refused = run([], { ARCPI_ARTIFACTS_DIR: name });
      assert.notEqual(refused.status, 0, `${name} is refused`);
      assert.ok(refused.stderr.includes('ARCPI_ARTIFACTS_DIR'));
    }
    rmSync(oldArtifact);

    renameSync(artifacts, join(project, 'saved-artifacts'));
    assert.equal(run().status, 0, 'A missing artifacts directory is harmless');
    assert.ok(existsSync(join(artifacts, '.arcpi-artifacts')), 'A missing artifacts directory is recreated and marked');
    rmSync(artifacts, { recursive: true });
    symlinkSync(temporary, artifacts);
    assert.equal(run().status, 0, 'An artifacts symlink is skipped');
    assert.ok(existsSync(outsideFile), 'A symlinked artifacts root must not be traversed');
    assert.equal(existsSync(join(temporary, '.arcpi-artifacts')), false, 'No marker is written through an artifacts symlink');
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
});
