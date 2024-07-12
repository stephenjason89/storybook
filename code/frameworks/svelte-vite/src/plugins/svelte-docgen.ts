import type { PluginOption } from 'vite';
import MagicString from 'magic-string';
import path from 'path';
import fs from 'fs';
import svelteDoc from 'sveltedoc-parser';
import type {
  SvelteComponentDoc,
  SvelteDataItem,
  SvelteParserOptions,
  JSDocType,
} from 'sveltedoc-parser';
import { logger } from 'storybook/internal/node-logger';
import { preprocess } from 'svelte/compiler';
import { replace, typescript } from 'svelte-preprocess';
import { generateDocgen, type Docgen, type Type } from './generateDocgen';

/*
 * Patch sveltedoc-parser internal options.
 * Waiting for a fix for https://github.com/alexprey/sveltedoc-parser/issues/87
 */
const svelteDocParserOptions = require('sveltedoc-parser/lib/options.js');

svelteDocParserOptions.getAstDefaultOptions = () => ({
  range: true,
  loc: true,
  comment: true,
  tokens: true,
  ecmaVersion: 12,
  sourceType: 'module',
  ecmaFeatures: {},
});

// Most of the code here should probably be exported by @storybook/svelte and reused here.
// See: https://github.com/storybookjs/storybook/blob/next/app/svelte/src/server/svelte-docgen-loader.ts

// From https://github.com/sveltejs/svelte/blob/8db3e8d0297e052556f0b6dde310ef6e197b8d18/src/compiler/compile/utils/get_name_from_filename.ts
// Copied because it is not exported from the compiler
function getNameFromFilename(filename: string) {
  if (!filename) return null;

  const parts = filename.split(/[/\\]/).map(encodeURI);

  if (parts.length > 1) {
    const indexMatch = parts[parts.length - 1].match(/^index(\.\w+)/);
    if (indexMatch) {
      parts.pop();
      parts[parts.length - 1] += indexMatch[1];
    }
  }

  const base = parts
    .pop()
    ?.replace(/%/g, 'u')
    .replace(/\.[^.]+$/, '')
    .replace(/[^a-zA-Z_$0-9]+/g, '_')
    .replace(/^_/, '')
    .replace(/_$/, '')
    .replace(/^(\d)/, '_$1');

  if (!base) {
    throw new Error(`Could not derive component name from file ${filename}`);
  }

  return base[0].toUpperCase() + base.slice(1);
}

function formatToSvelteDocParserType(type: Type): JSDocType {
  switch (type.type) {
    case 'string':
      return { kind: 'type', type: 'string', text: 'string' };
    case 'number':
      return { kind: 'type', type: 'number', text: 'number' };
    case 'boolean':
      return { kind: 'type', type: 'boolean', text: 'boolean' };
    case 'symbol':
      return { kind: 'type', type: 'symbol', text: 'symbol' };
    case 'object':
      return { kind: 'type', type: 'object', text: 'object' };
    case 'null':
      return { kind: 'type', type: 'other', text: 'null' };
    case 'any':
      return { kind: 'type', type: 'other', text: 'any' };
    case 'array':
      return { kind: 'type', type: 'array', text: 'array' };
    case 'reference':
      return { kind: 'type', type: 'other', text: type.text };
    case 'other':
      return { kind: 'type', type: 'other', text: type.text };
    case 'function':
      return { kind: 'function', text: type.text };
    case 'literal':
      return { kind: 'const', type: typeof type.value, value: type.value, text: type.text };
    case 'union': {
      const nonNull = type.types.filter((t) => t.type !== 'null'); // ignore null
      const text = nonNull.map((t): string => formatToSvelteDocParserType(t).text).join(' | ');
      const types = nonNull.map((t) => formatToSvelteDocParserType(t));
      return types.length === 1 ? types[0] : { kind: 'union', type: types, text };
    }
    case 'intersection': {
      const text = type.types.map((t): string => formatToSvelteDocParserType(t).text).join(' & ');
      return { kind: 'type', type: 'intersection', text };
    }
  }
}

function transformToSvelteDocParserDataItems(docgen: Docgen): SvelteDataItem[] {
  return docgen.props.map((p) => {
    const required = p.runes && p.defaultValue === undefined && p.type && !p.type.optional;
    return {
      name: p.name,
      visibility: 'public',
      description: p.description,
      keywords: required ? [{ name: 'required', description: '' }] : [],
      kind: 'let',
      type: p.type ? formatToSvelteDocParserType(p.type) : undefined,
      static: false,
      readonly: false,
      importPath: undefined,
      originalName: undefined,
      localName: undefined,
      defaultValue: p.defaultValue,
    } satisfies SvelteDataItem;
  });
}

export async function svelteDocgen(svelteOptions: Record<string, any> = {}): Promise<PluginOption> {
  const cwd = process.cwd();
  const { preprocess: preprocessOptions, logDocgen = false } = svelteOptions;
  const include = /\.(svelte)$/;
  const { createFilter } = await import('vite');

  const filter = createFilter(include);

  let docPreprocessOptions: Parameters<typeof preprocess>[1] | undefined;

  return {
    name: 'storybook:svelte-docgen-plugin',
    async transform(src: string, id: string) {
      if (!filter(id)) return undefined;

      const resource = path.relative(cwd, id);
      const rawSource = fs.readFileSync(resource).toString();

      // Get props information
      const docgen = generateDocgen(rawSource);
      const hasRuneProps = docgen.props.some((p) => p.runes);
      const data = transformToSvelteDocParserDataItems(docgen);

      let componentDoc: SvelteComponentDoc & { keywords?: string[] } = {};

      if (!hasRuneProps) {
        // Use sveltedoc-parser for generating documentation of events and slots.
        //
        // Note: Events and slots will be deprecated in Svelte 5.

        if (preprocessOptions && !docPreprocessOptions) {
          /*
           * We can't use vitePreprocess() for the documentation
           * because it uses esbuild which removes jsdoc.
           *
           * By default, only typescript is transpiled, and style tags are removed.
           *
           * Note: these preprocessors are only used to make the component
           * compatible to sveltedoc-parser (no ts), not to compile
           * the component.
           */
          docPreprocessOptions = [replace([[/<style.+<\/style>/gims, '']])];

          try {
            const ts = require.resolve('typescript');
            if (ts) {
              docPreprocessOptions.unshift(typescript());
            }
          } catch {
            // this will error in JavaScript-only projects, this is okay
          }
        }

        let docOptions;
        if (docPreprocessOptions) {
          const { code: fileContent } = await preprocess(rawSource, docPreprocessOptions, {
            filename: resource,
          });

          docOptions = {
            fileContent,
          };
        } else {
          docOptions = { filename: resource };
        }

        // set SvelteDoc options
        const options: SvelteParserOptions = {
          ...docOptions,
          version: 3,
        };

        try {
          componentDoc = await svelteDoc.parse(options);
        } catch (error: any) {
          componentDoc = { keywords: [], data: [] };
          if (logDocgen) {
            logger.error(error);
          }
        }
      }

      // Always use props info from generateDocgen
      componentDoc.data = data;

      // get filename for source content
      const file = path.basename(resource);

      componentDoc.name = path.basename(file);

      const s = new MagicString(src);
      const componentName = getNameFromFilename(resource);
      s.append(`;${componentName}.__docgen = ${JSON.stringify(componentDoc)}`);

      return {
        code: s.toString(),
        map: s.generateMap({ hires: true, source: id }),
      };
    },
  };
}
