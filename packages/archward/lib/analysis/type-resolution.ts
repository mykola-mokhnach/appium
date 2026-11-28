import path from 'node:path';

/** Resolves an import the way TypeScript does, to a path with `/` separators, or `undefined`. */
export type TypesResolver = (specifier: string, containingFile: string) => Promise<string | undefined>;

/**
 * Creates a resolver that uses the package's tsconfig. dependency-cruiser resolves to the runtime
 * file (`lodash/chunk.js`), while the types may come from another package (`@types/lodash`).
 */
export function createTypesResolver(packageDir: string, tsconfig: string): TypesResolver {
  let setup: Promise<(specifier: string, containingFile: string) => string | undefined> | undefined;
  const init = async () => {
    const {default: ts} = await import('typescript');
    const configFile = path.join(packageDir, tsconfig);
    const parsed = ts.parseJsonConfigFileContent(
      ts.readConfigFile(configFile, ts.sys.readFile).config ?? {},
      ts.sys,
      path.dirname(configFile),
    );
    return (specifier: string, containingFile: string) => {
      // under node16/nodenext the file's format (`.mts`, `"type": "module"`) selects the `import` or `require` condition
      const mode = ts.getImpliedNodeFormatForFile(containingFile, undefined, ts.sys, parsed.options);
      return ts.resolveModuleName(specifier, containingFile, parsed.options, ts.sys, undefined, undefined, mode)
        .resolvedModule?.resolvedFileName;
    };
  };
  return async (specifier, containingFile) => {
    setup ??= init();
    return (await setup)(specifier, path.join(packageDir, containingFile))?.replaceAll('\\', '/');
  };
}
