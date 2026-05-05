#!/usr/bin/env -S npx tsx
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

const require = createRequire(import.meta.url);

let resolved: string;
try {
  resolved = require.resolve('@actions/core');
} catch (e) {
  console.error('Failed to resolve @actions/core:', e);
  process.exit(1);
}

const pkgDir = join(dirname(resolved), '..');
const pkgPath = join(pkgDir, 'package.json');
const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));

console.log('Resolved @actions/core:');
console.log('  Path:    ', pkgDir);
console.log('  Version: ', pkg.version);
console.log('  Main:    ', pkg.main ?? '(none)');
console.log(
  '  Exports: ',
  pkg.exports ? JSON.stringify(pkg.exports, null, 2).replace(/\n/g, '\n  ') : '(none)'
);
if (pkg.exports && !pkg.main) {
  console.log(
    '\n⚠️  This package has "exports" but no "main" — can cause ERR_PACKAGE_PATH_NOT_EXPORTED with tsx. Use @actions/core@2.0.1.'
  );
}

// Also check @actions/github (v9 is ESM-only; use 7.0.0 for tsx)
try {
  const ghResolved = require.resolve('@actions/github');
  const ghPkgDir = join(dirname(ghResolved), '..');
  const ghPkg = JSON.parse(readFileSync(join(ghPkgDir, 'package.json'), 'utf8'));
  console.log('\nResolved @actions/github:');
  console.log('  Path:    ', ghPkgDir);
  console.log('  Version: ', ghPkg.version);
  console.log('  Main:    ', ghPkg.main ?? '(none)');
  console.log(
    '  Exports: ',
    ghPkg.exports ? JSON.stringify(ghPkg.exports, null, 2).replace(/\n/g, '\n  ') : '(none)'
  );
  if (ghPkg.exports && !ghPkg.main) {
    console.log('\n⚠️  @actions/github has "exports" but no "main" — pin to 7.0.0 for tsx.');
  }
} catch (e) {
  console.error('\nFailed to resolve @actions/github:', e);
}
