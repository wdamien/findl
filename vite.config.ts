/// <reference types="vitest" />
import { defineConfig } from 'vite';
import { resolve } from 'path';

export default defineConfig({
    test: {
        globals: true,
        environment: 'node',
        setupFiles: ['./tests/setup.ts'],
        include: ['**/*.{test,spec}.{js,mjs,cjs,ts,mts,cts,jsx,tsx}'],
        exclude: [
            '**/node_modules/**',
            '**/dist/**',
            '**/lib/**',
            '**/findl-tests/**',
        ],
    },
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
