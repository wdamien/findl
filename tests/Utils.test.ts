import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
    prettyGitURL,
    safeURL,
    ping,
    wait,
    walkPath,
    npmDepsToPaths,
} from '../src/Utils';
import * as https from 'https';
import { spawn } from 'child_process';

vi.mock('https');
vi.mock('child_process');

describe('Utils', () => {
    describe('prettyGitURL', () => {
        it('should return null for null input', () => {
            expect(prettyGitURL(null)).toBeNull();
        });

        it('should convert git+https URLs', () => {
            const input = 'git+https://github.com/user/repo.git';
            const expected = 'https://github.com/user/repo';
            expect(prettyGitURL(input)).toBe(expected);
        });

        it('should convert git@ URLs to https', () => {
            const input = 'git@github.com:user/repo.git';
            const expected = 'https://github.com/user/repo';
            expect(prettyGitURL(input)).toBe(expected);
        });

        it('should convert git:// URLs to https', () => {
            const input = 'git://github.com/user/repo.git';
            const expected = 'https://github.com/user/repo';
            expect(prettyGitURL(input)).toBe(expected);
        });

        it('should handle github: shorthand', () => {
            const input = 'github:user/repo';
            const expected = 'github.com/user/repo';
            expect(prettyGitURL(input)).toBe(expected);
        });

        it('should handle gitlab URLs', () => {
            const input = 'git@gitlab.com:user/repo.git';
            const expected = 'https://gitlab.com/user/repo';
            expect(prettyGitURL(input)).toBe(expected);
        });

        it('should handle bitbucket URLs', () => {
            const input = 'git@bitbucket.org:user/repo.git';
            const expected = 'https://bitbucket.org/user/repo';
            expect(prettyGitURL(input)).toBe(expected);
        });

        it('should remove .git extension', () => {
            const input = 'https://github.com/user/repo.git';
            const expected = 'https://github.com/user/repo';
            expect(prettyGitURL(input)).toBe(expected);
        });
    });

    describe('safeURL', () => {
        it('should parse valid URLs', () => {
            const url = 'https://github.com/user/repo';
            const result = safeURL(url);
            expect(result.hostname).toBe('github.com');
            expect(result.protocol).toBe('https:');
            expect(result.pathname).toBe('/user/repo');
        });

        it('should return safe object for invalid URLs', () => {
            const url = 'not-a-url';
            const result = safeURL(url);
            expect(result.hostname).toBeNull();
            expect(result.protocol).toBeNull();
            expect(result.pathname).toBeNull();
        });
    });

    describe('ping', () => {
        let mockRequest: any;
        let mockResponse: any;

        beforeEach(() => {
            mockResponse = {
                statusCode: 200,
                headers: {},
                on: vi.fn(),
            };

            mockRequest = {
                on: vi.fn(),
                end: vi.fn(),
            };

            (https.request as any) = vi.fn((options, callback) => {
                if (callback) {
                    callback(mockResponse);
                }
                return mockRequest;
            });
        });

        afterEach(() => {
            vi.clearAllMocks();
        });

        it('should return true for 200 status', async () => {
            mockResponse.statusCode = 200;
            mockResponse.on.mockImplementation(
                (event: string, callback: () => void) => {
                    if (event === 'data') {
                        // No data for HEAD request
                    } else if (event === 'end') {
                        callback();
                    }
                },
            );

            const result = await ping('https://github.com/user/repo');
            expect(result.result).toBe(true);
            expect(result.status).toBe(200);
        });

        it('should return false for 404 status', async () => {
            mockResponse.statusCode = 404;
            mockResponse.on.mockImplementation(
                (event: string, callback: () => void) => {
                    if (event === 'end') {
                        callback();
                    }
                },
            );

            const result = await ping('https://github.com/user/nonexistent');
            expect(result.result).toBe(false);
            expect(result.status).toBe(404);
        });

        it('should return redirect location for 301 status', async () => {
            mockResponse.statusCode = 301;
            mockResponse.headers.location = 'https://new-location.com';
            mockResponse.on.mockImplementation(
                (event: string, callback: () => void) => {
                    if (event === 'end') {
                        callback();
                    }
                },
            );

            const result = await ping('https://old-location.com');
            expect(result.result).toBe('https://new-location.com');
            expect(result.status).toBe(301);
        });

        it('should handle request errors', async () => {
            mockRequest.on.mockImplementation(
                (event: string, callback: (err: Error) => void) => {
                    if (event === 'error') {
                        callback(new Error('Network error'));
                    }
                },
            );

            const result = await ping('https://invalid-url.com');
            expect(result.result).toBe(false);
            expect(result.status).toBe(-1);
        });
    });

    describe('wait', () => {
        beforeEach(() => {
            vi.useFakeTimers();
        });

        afterEach(() => {
            vi.useRealTimers();
        });

        it('should wait for default delay of 1000ms', async () => {
            const promise = wait();
            vi.advanceTimersByTime(1000);
            await expect(promise).resolves.toBeUndefined();
        });

        it('should wait for custom delay', async () => {
            const promise = wait(500);
            vi.advanceTimersByTime(500);
            await expect(promise).resolves.toBeUndefined();
        });
    });

    describe('walkPath', () => {
        it('should extract package names from dependency tree', () => {
            const dependencies = {
                'package-a': {
                    dependencies: {
                        'package-b': {},
                        'package-c': {
                            dependencies: {
                                'package-d': {},
                            },
                        },
                    },
                },
                'package-e': {},
            };

            const results: string[] = [];
            walkPath(dependencies, results);

            expect(results).toContain('package-a');
            expect(results).toContain('package-b');
            expect(results).toContain('package-c');
            expect(results).toContain('package-d');
            expect(results).toContain('package-e');
            expect(results).toHaveLength(5);
        });

        it('should not add duplicate packages', () => {
            const dependencies = {
                'package-a': {
                    dependencies: {
                        'package-b': {},
                    },
                },
                'package-b': {},
            };

            const results: string[] = [];
            walkPath(dependencies, results);

            expect(results.filter((p) => p === 'package-b')).toHaveLength(1);
        });

        it('should handle empty dependencies', () => {
            const results: string[] = [];
            walkPath({}, results);
            expect(results).toHaveLength(0);
        });
    });

    describe('npmDepsToPaths', () => {
        let mockSpawn: any;

        beforeEach(() => {
            mockSpawn = {
                stdout: {
                    on: vi.fn(),
                },
                on: vi.fn(),
            };

            vi.mocked(spawn).mockReturnValue(mockSpawn as any);
        });

        afterEach(() => {
            vi.clearAllMocks();
        });

        it('should parse npm ls output and return package paths', async () => {
            const mockNpmOutput = JSON.stringify({
                dependencies: {
                    'package-a': {
                        dependencies: {
                            'package-b': {},
                        },
                    },
                    'package-c': {},
                },
            });

            mockSpawn.stdout.on.mockImplementation(
                (event: string, callback: (buf: Buffer) => void) => {
                    if (event === 'data') {
                        callback(Buffer.from(mockNpmOutput));
                    }
                },
            );

            mockSpawn.on.mockImplementation(
                (event: string, callback: () => void) => {
                    if (event === 'close') {
                        callback();
                    }
                },
            );

            const result = await npmDepsToPaths('/test/cwd', false);
            expect(result).toContain('package-a');
            expect(result).toContain('package-b');
            expect(result).toContain('package-c');
        });

        it('should handle npm command errors', async () => {
            vi.mocked(spawn).mockImplementation(() => {
                throw new Error('npm not found');
            });

            const result = await npmDepsToPaths('/test/cwd', false);
            expect(result).toBeNull();
        });

        it('should handle invalid JSON output', async () => {
            const invalidJson = 'invalid json output';

            mockSpawn.stdout.on.mockImplementation(
                (event: string, callback: (buf: Buffer) => void) => {
                    if (event === 'data') {
                        callback(Buffer.from(invalidJson));
                    }
                },
            );

            mockSpawn.on.mockImplementation(
                (event: string, callback: () => void) => {
                    if (event === 'close') {
                        callback();
                    }
                },
            );

            const result = await npmDepsToPaths('/test/cwd', false);
            expect(result).toBeNull();
        });

        it('should use correct depth parameter for deep scan', async () => {
            mockSpawn.stdout.on.mockImplementation(
                (event: string, callback: (buf: Buffer) => void) => {
                    if (event === 'data') {
                        callback(Buffer.from('{"dependencies":{}}'));
                    }
                },
            );

            mockSpawn.on.mockImplementation(
                (event: string, callback: () => void) => {
                    if (event === 'close') {
                        callback();
                    }
                },
            );

            await npmDepsToPaths('/test/cwd', true);

            expect(spawn).toHaveBeenCalledWith(
                expect.stringMatching(/npm(\.cmd)?$/),
                ['ls', '--prod', '--json', '--depth', 'Infinity'],
                { cwd: '/test/cwd' },
            );
        });
    });
});
