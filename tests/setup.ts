import { vi } from 'vitest';

// Mock external dependencies that are not relevant for unit tests
vi.mock('cli-progress', () => ({
    SingleBar: vi.fn(() => ({
        start: vi.fn(),
        update: vi.fn(),
        stop: vi.fn(),
    })),
    Presets: {
        shades_classic: {},
    },
}));

vi.mock('colors/safe', () => ({
    default: {
        bold: vi.fn((text: string) => text),
        green: vi.fn((text: string) => text),
        red: vi.fn((text: string) => text),
        yellow: vi.fn((text: string) => text),
        white: vi.fn((text: string) => text),
    },
}));

vi.mock('@octokit/rest', () => ({
    Octokit: vi.fn(() => ({
        rateLimit: {
            get: vi.fn(),
        },
        rest: {
            licenses: {
                getForRepo: vi.fn(),
            },
        },
    })),
}));

vi.mock('@octokit/auth-token', () => ({
    createTokenAuth: vi.fn(() => vi.fn(() => ({ token: 'mock-token' }))),
}));
