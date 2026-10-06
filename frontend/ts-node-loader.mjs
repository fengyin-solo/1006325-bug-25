// 仅用于 Node 下执行 TS 校验脚本：转译 TS 并把 @/ 别名解析到 src。
import { fileURLToPath, pathToFileURL } from 'node:url'
import { existsSync } from 'node:fs'
import path from 'node:path'
import ts from 'typescript'

const root = path.dirname(fileURLToPath(import.meta.url))
const srcDir = path.join(root, 'src')

export async function resolve(specifier, context, nextResolve) {
  if (specifier.startsWith('@/')) {
    const resolved = path.join(srcDir, specifier.slice(2))
    return tryResolve(resolved) ?? nextResolve(specifier, context)
  }
  if ((specifier.startsWith('./') || specifier.startsWith('../')) && context.parentURL) {
    const base = fileURLToPath(context.parentURL)
    const resolved = path.resolve(path.dirname(base), specifier)
    return tryResolve(resolved) ?? nextResolve(specifier, context)
  }
  return nextResolve(specifier, context)
}

function tryResolve(resolved) {
  const candidates = [resolved, resolved + '.ts', resolved + '.mts', path.join(resolved, 'index.ts')]
  for (const candidate of candidates) {
    if (existsSync(candidate) && /\.m?ts$/.test(candidate)) {
      return { url: pathToFileURL(candidate).href, shortCircuit: true }
    }
  }
  return null
}

export async function load(url, context, nextLoad) {
  if (url.endsWith('.ts') || url.endsWith('.mts') || url.endsWith('.tsx')) {
    const filePath = fileURLToPath(url)
    const source = await ts.sys.readFile(filePath) ?? ''
    const { outputText } = ts.transpileModule(source, {
      compilerOptions: {
        module: ts.ModuleKind.ESNext,
        target: ts.ScriptTarget.ES2020,
        sourceMap: false,
      },
      fileName: filePath,
    })
    return { format: 'module', source: outputText, shortCircuit: true }
  }
  return nextLoad(url, context)
}
