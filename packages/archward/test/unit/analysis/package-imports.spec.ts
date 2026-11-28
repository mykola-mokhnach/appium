import assert from 'node:assert/strict';
import {mkdir, mkdtemp, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {afterEach, beforeEach, describe, it} from 'node:test';

import {
  externalPackageName,
  findPackageImports,
  parseScopedSpecifier,
  readDeclaredDependencies,
  type PackageImportContext,
} from '../../../lib/analysis/package-imports.js';
import {createTypesResolver} from '../../../lib/analysis/type-resolution.js';
import {mod} from './modules.js';

describe('parseScopedSpecifier', () => {
  it('parses scoped specifiers', () => {
    assert.deepEqual(parseScopedSpecifier('@appium/support', ['@appium']), {pkg: '@appium/support'});
    assert.deepEqual(parseScopedSpecifier('@appium/support/lib/fs.js', ['@appium']), {
      pkg: '@appium/support',
      subpath: './lib/fs.js',
    });
    assert.equal(parseScopedSpecifier('@other/x', ['@appium']), null);
    assert.equal(parseScopedSpecifier('@appium/support', []), null);
  });
});

describe('externalPackageName', () => {
  it('names the package behind an import specifier', () => {
    assert.equal(externalPackageName('lodash'), 'lodash');
    assert.equal(externalPackageName('lodash/fp.js'), 'lodash');
    assert.equal(externalPackageName('@appium/support/lib/fs.js'), '@appium/support');
  });

  it('skips paths, `#` and `node:` imports and built-ins', () => {
    for (const skipped of [
      './a.js',
      '../a.js',
      '/abs.js',
      '#internal',
      'node:fs',
      'fs',
      'fs/promises',
      'data:text/js,1',
    ]) {
      assert.equal(externalPackageName(skipped), null, skipped);
    }
  });
});

describe('readDeclaredDependencies', () => {
  it('lets @types packages declare the types of the package they describe', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'archward-dd-'));
    try {
      await writeFile(
        path.join(dir, 'package.json'),
        JSON.stringify({
          name: 'me',
          dependencies: {a: '1'},
          devDependencies: {'@types/json-schema': '1', '@types/babel__core': '1', '@types/foo_bar__baz': '1', b: '1'},
        }),
      );
      const declared = await readDeclaredDependencies(dir);
      assert.deepEqual([...declared.runtime], ['a']);
      assert.deepEqual([...declared.dev].sort(), [
        '@types/babel__core',
        '@types/foo_bar__baz',
        '@types/json-schema',
        'b',
      ]);
      assert.deepEqual([...declared.typed].sort(), ['@babel/core', '@foo_bar/baz', 'json-schema']);
    } finally {
      await rm(dir, {recursive: true, force: true});
    }
  });
});

describe('findPackageImports', () => {
  let packageDir: string;

  beforeEach(async () => {
    packageDir = await mkdtemp(path.join(tmpdir(), 'archward-pi-'));
  });

  afterEach(async () => {
    await rm(packageDir, {recursive: true, force: true});
  });

  const context = (overrides: Partial<PackageImportContext> = {}): PackageImportContext => ({
    packageDir,
    prefix: 'lib/',
    entryPointScopes: ['@scope'],
    undeclaredDependencies: 'error',
    declared: {name: 'me', runtime: new Set(['dep']), dev: new Set(['dev-only']), typed: new Set(['typed'])},
    runtimeModules: [],
    resolveTypes: async () => undefined,
    ...overrides,
  });
  const keys = async (modules: ReturnType<typeof mod>[], ctx = context()) =>
    (await findPackageImports(modules, ctx)).map((f) => f.key);

  it('accepts declared packages, built-ins, the package itself and aliases into the source root', async () => {
    const modules = [
      mod('lib/a.ts', ['dep', 'dep/sub.js', 'node:fs', 'path', 'me', './x.js', {module: '@/x', resolved: 'lib/x.ts'}]),
    ];
    assert.deepEqual(await keys(modules, context({runtimeModules: modules})), []);
  });

  it('exempts tsconfig aliases that resolve to files of the package, wherever they point', async () => {
    const modules = [
      mod('lib/a.ts', [
        {module: '@shared/models', resolved: 'types/models.ts'},
        {module: '@/x', resolved: 'lib/x.ts'},
      ]),
    ];
    assert.deepEqual(await keys(modules, context({runtimeModules: modules})), []);
  });

  it('still checks packages that resolve into node_modules or to linked workspace packages', async () => {
    const modules = [
      mod('lib/a.ts', [
        {module: 'a', resolved: 'node_modules/a/index.js'},
        {module: 'b', resolved: '../../node_modules/b/index.js'},
        {module: 'c', resolved: '../c/build/lib/index.js'},
        {module: 'd', resolved: 'd', couldNotResolve: true},
      ]),
    ];
    assert.deepEqual(await keys(modules, context({runtimeModules: modules})), [
      'lib/a.ts -> a',
      'lib/a.ts -> b',
      'lib/a.ts -> c',
      'lib/a.ts -> d',
    ]);
  });

  it('reports undeclared packages', async () => {
    const modules = [mod('lib/a.ts', ['lodash', '@scope/x'])];
    assert.deepEqual(await keys(modules, context({runtimeModules: modules})), [
      'lib/a.ts -> @scope/x',
      'lib/a.ts -> lodash',
    ]);
  });

  it('accepts a devDependency for type-only imports only', async () => {
    const typeOnly = [mod('lib/a.ts', ['dev-only'])];
    assert.deepEqual(await keys(typeOnly), []);
    assert.deepEqual(await keys(typeOnly, context({runtimeModules: typeOnly})), ['lib/a.ts -> dev-only']);
  });

  describe('@types subpaths', () => {
    let workspace: string;

    // `dep` is hoisted next to the workspace; only `@types/typed` is declared by it
    beforeEach(async () => {
      workspace = path.join(packageDir, 'ws');
      const write = async (file: string, content: string) => {
        await mkdir(path.dirname(path.join(packageDir, file)), {recursive: true});
        await writeFile(path.join(packageDir, file), content);
      };
      await write('ws/tsconfig.json', '{"compilerOptions": {"moduleResolution": "bundler", "module": "esnext"}}');
      await write('ws/lib/a.ts', '');
      await write('node_modules/typed/package.json', '{"name": "typed"}');
      await write('node_modules/typed/chunk.js', '');
      await write('node_modules/typed/own.js', '');
      await write('node_modules/typed/own.d.ts', '');
      await write('node_modules/@types/typed/package.json', '{"name": "@types/typed"}');
      await write('node_modules/@types/typed/index.d.ts', '');
      await write('node_modules/@types/typed/chunk.d.ts', '');
    });

    const typedContext = () =>
      context({
        packageDir: workspace,
        resolveTypes: createTypesResolver(workspace, 'tsconfig.json'),
        declared: {name: 'me', runtime: new Set(), dev: new Set(), typed: new Set(['typed'])},
      });

    it('accepts a subpath whose types TypeScript takes from @types, though dependency-cruiser reports the .js file', async () => {
      const modules = [mod('lib/a.ts', ['typed', {module: 'typed/chunk', resolved: 'node_modules/typed/chunk.js'}])];
      assert.deepEqual(await keys(modules, typedContext()), []);
    });

    it('rejects a subpath that @types does not provide', async () => {
      const modules = [
        mod('lib/a.ts', [
          {module: 'typed/own', resolved: 'node_modules/typed/own.js'},
          {module: 'typed/gone', resolved: 'typed/gone', couldNotResolve: true},
        ]),
      ];
      assert.deepEqual(await keys(modules, typedContext()), ['lib/a.ts -> typed']);
    });

    it('does not accept @types for runtime imports', async () => {
      const modules = [mod('lib/a.ts', ['typed'])];
      assert.deepEqual(await keys(modules, {...typedContext(), runtimeModules: modules}), ['lib/a.ts -> typed']);
    });
  });

  it('reports deep imports of scoped packages that are not exported', async () => {
    const modules = [mod('lib/a.ts', ['@scope/dep/lib/x.js'])];
    const ctx = context({
      runtimeModules: modules,
      declared: {runtime: new Set(['@scope/dep']), dev: new Set(), typed: new Set()},
    });
    assert.deepEqual(await keys(modules, ctx), ['lib/a.ts -> @scope/dep/lib/x.js']);
  });

  it('checks only scoped packages unless asked for more', async () => {
    const modules = [mod('lib/a.ts', ['lodash', '@scope/x'])];
    const ctx = context({runtimeModules: modules, undeclaredDependencies: 'ignore'});
    assert.deepEqual(await keys(modules, ctx), ['lib/a.ts -> @scope/x']);
  });

  it('ignores files outside the source root', async () => {
    assert.deepEqual(await keys([mod('../other/a.ts', ['lodash'])]), []);
  });
});
