import { describe, it, expect, vi, beforeEach } from 'vitest';
import { run } from '../index';

// Mock all external dependencies
vi.mock('async');
vi.mock('cli-progress');
vi.mock('colors/safe');
vi.mock('fs-extra');
vi.mock('yargs');
vi.mock('@octokit/rest');
vi.mock('@octokit/auth-token');

// Mock the processor modules
vi.mock('../src/node-processor', () => ({
    processNPMQueue: vi.fn(),
    getNPMdeps: vi.fn(),
    getYarnBerryDeps: vi.fn(),
    setNodeProcessorCwd: vi.fn(),
    setNodeProgressBar: vi.fn(),
    setNodeResult: vi.fn(),
}));

vi.mock('../src/dart-processor', () => ({
    processPubspecQueue: vi.fn(),
    getDartDeps: vi.fn(),
    setDartProcessorCwd: vi.fn(),
    setDartProgressBar: vi.fn(),
    setDartResult: vi.fn(),
}));

vi.mock('../src/shared-utils', () => ({
    setVerbose: vi.fn(),
    setCwd: vi.fn(),
    setOctokit: vi.fn(),
    setUseGithubAPI: vi.fn(),
    wrapInMarkdownUrl: vi.fn(),
    formatMissingReason: vi.fn(),
    loadIgnoreFile: vi.fn(() => ({ ignores: vi.fn(() => false) })),
    findProjectType: vi.fn(),
}));

describe('index', () => {
    beforeEach(() => {
        vi.clearAllMocks();

        // Mock process.argv
        process.argv = ['node', 'findl', '--verbose'];

        // Mock process.cwd
        vi.spyOn(process, 'cwd').mockReturnValue('/test/cwd');

        // Mock console methods
        vi.spyOn(console, 'log').mockImplementation(() => {});
        vi.spyOn(console, 'error').mockImplementation(() => {});
    });

    it('should export run function', () => {
        expect(typeof run).toBe('function');
    });

    it('should handle no supported project type found', async () => {
        const { findProjectType } = await import('../src/shared-utils');
        vi.mocked(findProjectType).mockResolvedValue(null);

        await run();

        expect(console.log).toHaveBeenCalledWith(
            expect.stringContaining('No supported dependencies file found')
        );
    });
});
