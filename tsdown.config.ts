/**
 * tsdown config for dsh-yuque-kb — a dual-face dsh web plugin.
 *
 * Host half: `lib/index.js` + `lib/invariant.js` (ESM, node platform). Every
 * bare specifier stays an import: node builtins and `@deepseek-ai/*` peers
 * resolve from the dsh runtime install; `schemastery` resolves from this
 * package's own `dependencies`.
 *
 * Browser half: `lib/client.js` (CJS closure factory) — the exact artifact
 * format the web shell's module loader expects:
 * `window.__ModuleLoader__.load({ id, factory: (require) => {...} })`.
 * Baseline module-table specifiers (react*, @deepseek-ai/cordis, client
 * packages) stay externals resolved through the injected `require`; anything
 * else is bundled. CSS Modules / global CSS are compiled by lightningcss and
 * injected as plugin-owned style tags at factory execution (mirror of the
 * official `clientBundle` preset, https://github.com/deepseek-ai/deepseek-harness).
 */
import { readFile } from 'node:fs/promises'
import { isBuiltin } from 'node:module'
import { existsSync, readFileSync } from 'node:fs'
import { basename, dirname, isAbsolute, resolve as resolvePath, sep } from 'node:path'
import type { UserConfig } from 'tsdown'
import { transform } from 'lightningcss'

const PLUGIN_ID = 'dsh-yuque-kb'

/** Module-table specifiers the web shell seeds; a client bundle keeps them as imports. */
const PLATFORM_MODULES: readonly string[] = [
  'react', 'react/jsx-runtime', 'react-dom', 'react-dom/client', '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-client-ui-primitives',
]

/** Specifiers the parser preloads before the shell starts. */
const PRELOADED_CLIENT_EXTERNALS: readonly string[] = ['@deepseek-ai/dsh-client-runtime/client']

/** Production dependencies of this package — the host half keeps them as imports. */
const PRODUCTION_DEPENDENCIES: readonly string[] = Object.keys(
  JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')).dependencies ?? {},
)

/** Every @deepseek-ai/* package stays external to the browser bundle (module table rows). */
const isExternalBare = (specifier: string): boolean =>
  isBuiltin(specifier)
  || specifier.startsWith('@deepseek-ai/')
  || specifier === 'schemastery'
  || PRODUCTION_DEPENDENCIES.some(dep => specifier === dep || specifier.startsWith(`${dep}/`))

const hostConfig: UserConfig = {
  name: PLUGIN_ID,
  entry: { index: 'lib/types/index.js', invariant: 'lib/types/invariant.js' },
  outDir: 'lib',
  format: ['esm'],
  platform: 'node',
  target: 'es2024',
  fixedExtension: false,
  dts: false,
  clean: false,
  deps: {
    neverBundle: isExternalBare,
    alwaysBundle: (specifier: string) => !isExternalBare(specifier),
  },
}

const isRequested = (specifier: string): boolean =>
  PLATFORM_MODULES.includes(specifier) || PRELOADED_CLIENT_EXTERNALS.includes(specifier)

// ── CSS handling (independent mirror of the official clientBundle preset) ──

const CSS_VIRTUAL_PREFIX = '\0dsh-css:'
const GLOBAL_CSS_VIRTUAL_PREFIX = '\0dsh-global-css:'
const INLINE_CSS_VIRTUAL_PREFIX = '\0dsh-inline-css:'
const CSS_VIRTUAL_SUFFIX = '.mjs'
const INLINE_CSS_QUERY = '?inline'
const SOURCE_MARKER = `${sep}src${sep}`

/** Emit one plugin-owned style injector and an optional CSS Modules export. */
function styleInjectionModule(
  id: string,
  fileId: string,
  css: string,
  classMap?: Readonly<Record<string, string>>,
): string {
  const source = [
    `const css = ${JSON.stringify(css)};`,
    `const tagId = ${JSON.stringify(`${id}/${basename(fileId)}`)};`,
    'if (typeof document !== \'undefined\' && document.querySelector(\'style[data-plugin-css=\' + JSON.stringify(tagId) + \']\') === null) {',
    '  const tag = document.createElement(\'style\');',
    `  tag.dataset.plugin = ${JSON.stringify(id)};`,
    '  tag.dataset.pluginCss = tagId;',
    '  tag.textContent = css;',
    '  document.head.appendChild(tag);',
    '}',
  ]
  source.push(classMap === undefined ? 'export {};' : `export default ${JSON.stringify(classMap)};`)
  return source.join('\n')
}

/** Path segment separating a package's tsc output from the sources it was emitted from. */
const TYPES_MARKER = `${sep}lib${sep}types${sep}`

/** Resolve a stylesheet import against physical sources (emitted or source tree). */
function sourceAssetPath(source: string, importer: string): string {
  const emitted = resolvePath(dirname(importer), source)
  if (existsSync(emitted)) return emitted
  const boundary = emitted.indexOf(TYPES_MARKER)
  if (boundary < 0) return emitted
  return resolvePath(emitted.slice(0, boundary), 'src', emitted.slice(boundary + TYPES_MARKER.length))
}

interface AssetEmitter {
  emitFile(file: { type: 'asset'; fileName: string; source: Uint8Array; originalFileName: string }): string
}

const clientConfig: UserConfig = {
  name: `${PLUGIN_ID}/client`,
  entry: { client: 'lib/types/client/index.js' },
  outDir: 'lib',
  format: 'cjs',
  platform: 'browser',
  dts: false,
  sourcemap: true,
  clean: false,
  deps: {
    neverBundle: isRequested,
    alwaysBundle: (specifier: string) => !isRequested(specifier),
  },
  define: {
    'process.env.NODE_ENV': JSON.stringify(process.env.NODE_ENV ?? 'production'),
    'import.meta.env.MODE': JSON.stringify(process.env.NODE_ENV ?? 'production'),
    'import.meta.env': JSON.stringify({ MODE: process.env.NODE_ENV ?? 'production' }),
  },
  plugins: [
    {
      name: 'dsh-css-modules-inline',
      resolveId(source: string, importer: string | undefined) {
        if (!source.endsWith('.module.css')) return null
        const abs = importer !== undefined ? sourceAssetPath(source, importer) : source
        return CSS_VIRTUAL_PREFIX + abs + CSS_VIRTUAL_SUFFIX
      },
      async load(this: { addWatchFile(id: string): void }, virtualId: string) {
        if (!virtualId.startsWith(CSS_VIRTUAL_PREFIX)) return null
        const fileId = virtualId.slice(CSS_VIRTUAL_PREFIX.length, -CSS_VIRTUAL_SUFFIX.length)
        this.addWatchFile(fileId)
        const source = await readFile(fileId)
        const { code, exports: cssExports } = transform({
          filename: fileId,
          code: source,
          cssModules: { pattern: '[hash]_[local]' },
          minify: true,
        })
        const classMap: Record<string, string> = {}
        const exportEntries = Object.entries(cssExports ?? {})
          .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
        for (const [local, exp] of exportEntries) classMap[local] = exp.name
        return styleInjectionModule(PLUGIN_ID, fileId, code.toString(), classMap)
      },
    },
    {
      name: 'dsh-css-text-inline',
      resolveId(source: string, importer: string | undefined) {
        if (!source.endsWith(`.css${INLINE_CSS_QUERY}`)) return null
        const stylesheet = source.slice(0, -INLINE_CSS_QUERY.length)
        const abs = importer !== undefined ? sourceAssetPath(stylesheet, importer) : stylesheet
        return INLINE_CSS_VIRTUAL_PREFIX + abs + CSS_VIRTUAL_SUFFIX
      },
      async load(this: { addWatchFile(id: string): void }, virtualId: string) {
        if (!virtualId.startsWith(INLINE_CSS_VIRTUAL_PREFIX)) return null
        const fileId = virtualId.slice(INLINE_CSS_VIRTUAL_PREFIX.length, -CSS_VIRTUAL_SUFFIX.length)
        this.addWatchFile(fileId)
        const source = await readFile(fileId)
        const { code } = transform({ filename: fileId, code: source, minify: true })
        return `export default ${JSON.stringify(code.toString())};`
      },
    },
    {
      name: 'dsh-css-global-inline',
      resolveId(source: string, importer: string | undefined) {
        if (!source.endsWith('.css') || source.endsWith('.module.css')) return null
        const abs = importer !== undefined ? sourceAssetPath(source, importer) : source
        return GLOBAL_CSS_VIRTUAL_PREFIX + abs + CSS_VIRTUAL_SUFFIX
      },
      async load(this: { addWatchFile(id: string): void }, virtualId: string) {
        if (!virtualId.startsWith(GLOBAL_CSS_VIRTUAL_PREFIX)) return null
        const fileId = virtualId.slice(GLOBAL_CSS_VIRTUAL_PREFIX.length, -CSS_VIRTUAL_SUFFIX.length)
        this.addWatchFile(fileId)
        const source = await readFile(fileId)
        const { code } = transform({ filename: fileId, code: source, minify: true })
        return styleInjectionModule(PLUGIN_ID, fileId, code.toString())
      },
    },
  ],
  outputOptions: {
    entryFileNames: 'client.js',
    banner: `window.__ModuleLoader__.load({ id: ${JSON.stringify(PLUGIN_ID)}, factory: (require) => {`,
    footer: 'return module.exports; } });',
    intro: 'var module = { exports: {} }; var exports = module.exports;',
  },
}

export default [hostConfig, clientConfig]