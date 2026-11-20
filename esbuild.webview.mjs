import * as esbuild from 'esbuild';

const production = process.argv.includes('--production');

await esbuild.build({
    entryPoints: ['src/webview/index.tsx'],
    bundle: true,
    outfile: 'out/webview/index.js',
    format: 'iife',
    platform: 'browser',
    target: 'es2020',
    minify: production,
    sourcemap: !production,
    jsx: 'automatic',
    loader: {
        '.woff': 'file',
        '.ttf': 'file',
    },
    assetNames: 'assets/[name]-[hash]',
    define: {
        'process.env.NODE_ENV': production ? '"production"' : '"development"',
    },
});
