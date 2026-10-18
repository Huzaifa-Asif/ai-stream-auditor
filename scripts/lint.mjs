import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

for (const file of [
  'src/index.cjs',
  'src/index.js',
  'test/audit.test.js',
  'test/anthropic-sdk.integration.test.js',
  'test/regressions.test.js',
  'scripts/lint.mjs',
  'examples/audit-openai.mjs',
  'examples/audit-anthropic.mjs',
]) {
  execFileSync(process.execPath, ['--check', file], { stdio: 'inherit' });
}
const packageJson = JSON.parse(readFileSync('package.json', 'utf8'));
if (packageJson.license !== 'MIT') throw new Error('package license must be MIT');
if (Object.keys(packageJson.dependencies || {}).length > 0) throw new Error('runtime dependencies are not allowed');
