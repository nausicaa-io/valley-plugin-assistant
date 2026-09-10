import { build } from 'esbuild'
import fs from 'node:fs/promises'
import path from 'node:path'

export default async function ({ root, outDir }) {
  const harnesses = {}
  for (const id of ['jarvis', 'windmill']) {
    const source = path.join(root, 'src/backend/harness/builtins', id)
    const files = {}
    for (const name of (await fs.readdir(path.join(source, 'src'))).filter((name) => name.endsWith('.ts') && !/claude/i.test(name))) files[`src/${name}`] = await fs.readFile(path.join(source, 'src', name), 'utf8')
    harnesses[id] = { manifest: JSON.parse(await fs.readFile(path.join(source, 'manifest.json'), 'utf8')), config: JSON.parse(await fs.readFile(path.join(source, 'config.json'), 'utf8')), files }
  }
  await fs.mkdir(path.join(outDir, 'assets/harnesses'), { recursive: true })
  await fs.writeFile(path.join(outDir, 'assets/harnesses/index.json'), JSON.stringify(harnesses))
  await build({ absWorkingDir: root, entryPoints: [path.join(root, 'src/charts/islandRuntime.tsx')], outfile: path.join(outDir, 'assets/charts.js'), bundle: true, platform: 'browser', format: 'esm', target: 'es2022', jsx: 'automatic', conditions: ['production'], minify: true })
  return {
    backendOptions: {
      plugins: [{
        name: 'typescript-browser-runtime',
        setup(build) {
          build.onResolve({ filter: /^(?:fs|path|os|crypto|perf_hooks|inspector|source-map-support)$/ }, (args) => {
            if (!/[\\/]node_modules[\\/]typescript[\\/]lib[\\/]typescript\.js$/.test(args.importer)) return
            return { path: args.path, namespace: 'typescript-optional-node' }
          })
          build.onLoad({ filter: /.*/, namespace: 'typescript-optional-node' }, () => ({ contents: 'export {}', loader: 'js' }))
        }
      }]
    }
  }
}
