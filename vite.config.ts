import { defineConfig } from 'vite';
import { resolve } from 'path';

export default defineConfig({
    build: {
        lib: {
            entry: resolve(__dirname, 'index.ts'),
            name: 'findl',
            fileName: 'index',
            formats: ['cjs'],
        },
        rollupOptions: {
            external: [
                // Node.js built-ins
                'fs',
                'path',
                'os',
                'child_process',
                'https',
                'url',
                // Dependencies that should remain external
                'async',
                'cli-progress',
                'colors/safe',
                'fs-extra',
                'package-json',
                'type-fest',
                'yamljs',
                'yargs',
                'node-fetch',
                '@octokit/rest',
                '@octokit/auth-token',
                'glob',
                'resolve-package-path',
                'yaml',
                'ignore',
            ],
        },
        outDir: 'lib',
        target: 'node14',
        minify: true,
    },
    resolve: {
        alias: {
            '@': resolve(__dirname, 'src'),
        },
    },
});
