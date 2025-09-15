import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
    isValidUrl,
    wrapInMarkdownUrl,
    validateLicenseName,
    getLicenseFromRepository,
    validateLicenseURL,
    formatMissingReason,
    log,
    loadIgnoreFile,
    findProjectType,
    setVerbose,
    setCwd,
    setOctokit,
    setUseGithubAPI,
} from '../src/shared-utils';
import { QueueItem, DependencyType, ProjectType } from '../src/types';
import * as fs from 'fs-extra';

vi.mock('fs-extra', () => ({
    existsSync: vi.fn(),
    readFileSync: vi.fn(),
    pathExists: vi.fn(),
}));

vi.mock('../src/Utils', () => ({
    ping: vi.fn(),
    wait: vi.fn(),
}));

// Import the mocked functions
import { ping, wait } from '../src/Utils';

describe('shared-utils', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        // Reset module state
        setVerbose(false);
        setCwd('/test/cwd');
    });

    describe('isValidUrl', () => {
        it('should return false for null', () => {
            expect(isValidUrl(null)).toBe(false);
        });

        it('should return true for valid URLs', () => {
            expect(isValidUrl('https://github.com/user/repo')).toBe(true);
            expect(isValidUrl('http://example.com')).toBe(true);
            expect(isValidUrl('ftp://files.example.com')).toBe(true);
        });

        it('should return false for invalid URLs', () => {
            expect(isValidUrl('not-a-url')).toBe(false);
            expect(isValidUrl('github.com/user/repo')).toBe(false);
            expect(isValidUrl('')).toBe(false);
        });
    });

    describe('wrapInMarkdownUrl', () => {
        it('should wrap valid URLs in markdown format', () => {
            const url = 'https://github.com/user/repo';
            const result = wrapInMarkdownUrl(url);
            expect(result).toBe(`[${url}](${url})`);
        });

        it('should use custom text when provided', () => {
            const url = 'https://github.com/user/repo';
            const text = 'Repository';
            const result = wrapInMarkdownUrl(url, text);
            expect(result).toBe(`[${text}](${url})`);
        });

        it('should return the original value for invalid URLs', () => {
            const invalidUrl = 'not-a-url';
            const result = wrapInMarkdownUrl(invalidUrl);
            expect(result).toBe(invalidUrl);
        });

        it('should return null for null input', () => {
            const result = wrapInMarkdownUrl(null);
            expect(result).toBeNull();
        });
    });

    describe('validateLicenseName', () => {
        it('should return valid license names', () => {
            expect(validateLicenseName('MIT')).toBe('MIT');
            expect(validateLicenseName('Apache-2.0')).toBe('Apache-2.0');
            expect(validateLicenseName('GPL-3.0')).toBe('GPL-3.0');
        });

        it('should return undefined for invalid characters', () => {
            expect(validateLicenseName('License/')).toBeUndefined();
            expect(validateLicenseName('License"')).toBeUndefined();
            expect(validateLicenseName("License'")).toBeUndefined();
            expect(validateLicenseName('License:')).toBeUndefined();
        });

        it('should return undefined for unknown licenses', () => {
            expect(validateLicenseName('UNKNOWN-LICENSE')).toBeUndefined();
        });

        it('should handle undefined input', () => {
            expect(validateLicenseName(undefined)).toBeUndefined();
        });
    });

    describe('getLicenseFromRepository', () => {
        let mockOctokit: any;

        beforeEach(() => {
            mockOctokit = {
                rest: {
                    licenses: {
                        getForRepo: vi.fn(),
                    },
                },
            };
            setOctokit(mockOctokit);
            setUseGithubAPI(true);
        });

        it('should extract license from GitHub repository', async () => {
            const mockLicenseResponse = {
                data: {
                    license: {
                        spdx_id: 'MIT',
                    },
                    html_url: 'https://github.com/user/repo/blob/main/LICENSE',
                },
            };

            mockOctokit.rest.licenses.getForRepo.mockResolvedValue(
                mockLicenseResponse
            );

            const result = await getLicenseFromRepository(
                'https://github.com/user/repo'
            );

            expect(result.license).toBe('MIT');
            expect(result.licenseUrl).toBe(
                'https://github.com/user/repo/blob/main/LICENSE'
            );
            expect(mockOctokit.rest.licenses.getForRepo).toHaveBeenCalledWith({
                owner: 'user',
                repo: 'repo',
            });
        });

        it('should handle github: shorthand URLs', async () => {
            const mockLicenseResponse = {
                data: {
                    license: {
                        spdx_id: 'Apache-2.0',
                    },
                    html_url: 'https://github.com/user/repo/blob/main/LICENSE',
                },
            };

            mockOctokit.rest.licenses.getForRepo.mockResolvedValue(
                mockLicenseResponse
            );

            const result = await getLicenseFromRepository('github:user/repo');

            expect(result.license).toBe('Apache-2.0');
            expect(mockOctokit.rest.licenses.getForRepo).toHaveBeenCalledWith({
                owner: 'user',
                repo: 'repo',
            });
        });

        it('should handle API errors gracefully', async () => {
            mockOctokit.rest.licenses.getForRepo.mockRejectedValue({
                status: 404,
                response: {
                    url: 'https://api.github.com/repos/user/repo/license',
                    data: { message: 'Not Found' },
                },
            });

            const result = await getLicenseFromRepository(
                'https://github.com/user/repo'
            );

            expect(result.license).toBeUndefined();
            expect(result.licenseUrl).toBeUndefined();
        });

        it('should skip API call when useGithubAPI is false', async () => {
            setUseGithubAPI(false);

            const result = await getLicenseFromRepository(
                'https://github.com/user/repo'
            );

            expect(result.license).toBeUndefined();
            expect(result.licenseUrl).toBeUndefined();
            expect(mockOctokit.rest.licenses.getForRepo).not.toHaveBeenCalled();
        });

        it('should handle NOASSERTION license', async () => {
            const mockLicenseResponse = {
                data: {
                    license: {
                        spdx_id: 'NOASSERTION',
                    },
                    html_url: 'https://github.com/user/repo/blob/main/LICENSE',
                },
            };

            mockOctokit.rest.licenses.getForRepo.mockResolvedValue(
                mockLicenseResponse
            );

            const result = await getLicenseFromRepository(
                'https://github.com/user/repo'
            );

            expect(result.license).toBeUndefined();
            expect(result.licenseUrl).toBe(
                'https://github.com/user/repo/blob/main/LICENSE'
            );
        });
    });

    describe('validateLicenseURL', () => {
        beforeEach(async () => {
            const { ping, wait } = await import('../src/Utils');
            vi.mocked(ping).mockResolvedValue({ result: true, status: 200 });
            vi.mocked(wait).mockResolvedValue();
        });

        it('should find license URL for GitHub repository', async () => {
            const { ping } = await import('../src/Utils');
            vi.mocked(ping).mockResolvedValue({ result: true, status: 200 });

            const result = await validateLicenseURL(
                'https://github.com/user/repo',
                'LICENSE'
            );

            expect(result).toEqual({
                licenseUrl: 'https://github.com/user/repo/blob/main/LICENSE',
                license: null,
            });
        });

        it('should try different branch names', async () => {
            vi.mocked(ping)
                .mockResolvedValueOnce({ result: false, status: 404 })
                .mockResolvedValueOnce({ result: true, status: 200 });

            const result = await validateLicenseURL(
                'https://github.com/user/repo',
                'LICENSE'
            );

            expect(result).toEqual({
                licenseUrl: 'https://github.com/user/repo/blob/master/LICENSE',
                license: null,
            });
        });

        it('should handle BitBucket repositories', async () => {
            vi.mocked(ping).mockResolvedValue({ result: true, status: 200 });

            const result = await validateLicenseURL(
                'https://bitbucket.org/user/repo',
                'LICENSE'
            );

            expect(result).toEqual({
                licenseUrl: 'https://bitbucket.org/user/repo/src/main/LICENSE',
                license: null,
            });
        });

        it('should return null when no license file is found', async () => {
            vi.mocked(ping).mockResolvedValue({ result: false, status: 404 });

            const result = await validateLicenseURL(
                'https://github.com/user/repo',
                'LICENSE'
            );

            expect(result).toBeNull();
        });

        it('should handle rate limiting', async () => {
            vi.mocked(ping)
                .mockResolvedValueOnce({ result: false, status: 429 })
                .mockResolvedValueOnce({ result: true, status: 200 });

            const result = await validateLicenseURL(
                'https://github.com/user/repo',
                'LICENSE'
            );

            expect(result).toEqual({
                licenseUrl: 'https://github.com/user/repo/blob/main/LICENSE',
                license: null,
            });
        });
    });

    describe('formatMissingReason', () => {
        it('should format missing-repo reason', () => {
            const item: QueueItem = {
                name: 'test-package',
                parent: '/test',
                repositoryURL: null,
                mainRepositoryURL: null,
                licenseUrl: null,
                licenseUrlIsValid: null,
                licenseIsValid: null,
                missingLicenseReason: 'missing-repo',
            };

            const result = formatMissingReason(item);
            expect(result).toBe(' -> Cannot find valid git repository path.');
        });

        it('should format no-local reason', () => {
            const item: QueueItem = {
                name: 'test-package',
                parent: '/test',
                repositoryURL: null,
                mainRepositoryURL: null,
                licenseUrl: null,
                licenseUrlIsValid: null,
                licenseIsValid: null,
                missingLicenseReason: 'no-local',
            };

            const result = formatMissingReason(item);
            expect(result).toBe(' -> Cannot find a license on your disk.');
        });

        it('should format no-web reason', () => {
            const item: QueueItem = {
                name: 'test-package',
                parent: '/test',
                repositoryURL: null,
                mainRepositoryURL: null,
                licenseUrl: null,
                licenseUrlIsValid: null,
                licenseIsValid: null,
                missingLicenseReason: 'no-web',
            };

            const result = formatMissingReason(item);
            expect(result).toBe(' -> Cannot find a license on the web.');
        });
    });

    describe('log', () => {
        let consoleSpy: any;

        beforeEach(() => {
            consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
            vi.spyOn(console, 'error').mockImplementation(() => {});
        });

        afterEach(() => {
            consoleSpy.mockRestore();
        });

        it('should not log when verbose is false', () => {
            setVerbose(false);
            log('test message');
            expect(console.log).not.toHaveBeenCalled();
        });

        it('should log string messages when verbose is true', () => {
            setVerbose(true);
            log('test message', 'value');
            expect(console.log).toHaveBeenCalledWith('test message: value');
        });

        it('should log QueueItem messages when verbose is true', () => {
            setVerbose(true);
            const item: QueueItem = {
                name: 'test-package',
                parent: '/test',
                repositoryURL: null,
                mainRepositoryURL: null,
                licenseUrl: null,
                licenseUrlIsValid: null,
                licenseIsValid: null,
            };
            log(item, 'processing');
            expect(console.log).toHaveBeenCalledWith(
                'test-package: processing'
            );
        });

        it('should log errors', () => {
            setVerbose(true);
            const error = new Error('Test error');
            log(error);
            expect(console.error).toHaveBeenCalledWith('Error', 'Test error');
        });

        it('should stringify object values', () => {
            setVerbose(true);
            const obj = { key: 'value' };
            log('test', obj);
            expect(console.log).toHaveBeenCalledWith('test: {"key":"value"}');
        });
    });

    describe('loadIgnoreFile', () => {
        beforeEach(() => {
            setCwd('/test/cwd');
        });

        it('should load ignore patterns from file', () => {
            const ignoreContent = 'node_modules\n*.log\ntemp/';
            vi.mocked(fs.existsSync).mockReturnValue(true);
            vi.mocked(fs.readFileSync).mockReturnValue(ignoreContent);

            const ig = loadIgnoreFile();

            expect(fs.existsSync).toHaveBeenCalledWith(
                '/test/cwd/.findlignore'
            );
            expect(fs.readFileSync).toHaveBeenCalledWith(
                '/test/cwd/.findlignore',
                'utf8'
            );
            expect(ig.ignores('node_modules')).toBe(true);
            expect(ig.ignores('test.log')).toBe(true);
            expect(ig.ignores('temp/file.txt')).toBe(true);
            expect(ig.ignores('src/index.js')).toBe(false);
        });

        it('should return empty ignore when file does not exist', () => {
            vi.mocked(fs.existsSync).mockReturnValue(false);

            const ig = loadIgnoreFile();

            expect(fs.readFileSync).not.toHaveBeenCalled();
            expect(ig.ignores('anything')).toBe(false);
        });
    });

    describe('findProjectType', () => {
        const mockProjectTypes: ProjectType[] = [
            {
                type: DependencyType.yarnBerry,
                anchorFile: '.yarnrc.yml',
                createDependencyList: vi.fn(),
                processor: vi.fn(),
            },
            {
                type: DependencyType.npm,
                anchorFile: 'package.json',
                createDependencyList: vi.fn(),
                processor: vi.fn(),
            },
            {
                type: DependencyType.dart,
                anchorFile: 'pubspec.yaml',
                createDependencyList: vi.fn(),
                processor: vi.fn(),
            },
        ];

        beforeEach(() => {
            setCwd('/test/cwd');
        });

        it('should find yarn berry project', async () => {
            (fs.pathExists as any)
                .mockResolvedValueOnce(true)
                .mockResolvedValueOnce(false)
                .mockResolvedValueOnce(false);

            const result = await findProjectType(mockProjectTypes);

            expect(result).toBe(mockProjectTypes[0]);
            expect(fs.pathExists).toHaveBeenCalledWith('/test/cwd/.yarnrc.yml');
        });

        it('should find npm project', async () => {
            (fs.pathExists as any)
                .mockResolvedValueOnce(false)
                .mockResolvedValueOnce(true)
                .mockResolvedValueOnce(false);

            const result = await findProjectType(mockProjectTypes);

            expect(result).toBe(mockProjectTypes[1]);
            expect(fs.pathExists).toHaveBeenCalledWith(
                '/test/cwd/package.json'
            );
        });

        it('should find dart project', async () => {
            (fs.pathExists as any)
                .mockResolvedValueOnce(false)
                .mockResolvedValueOnce(false)
                .mockResolvedValueOnce(true);

            const result = await findProjectType(mockProjectTypes);

            expect(result).toBe(mockProjectTypes[2]);
            expect(fs.pathExists).toHaveBeenCalledWith(
                '/test/cwd/pubspec.yaml'
            );
        });

        it('should return null when no project type is found', async () => {
            (fs.pathExists as any).mockResolvedValue(false);

            const result = await findProjectType(mockProjectTypes);

            expect(result).toBeNull();
        });
    });
});
