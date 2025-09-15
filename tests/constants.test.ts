import { describe, it, expect } from 'vitest';
import {
    IgnoreFileName,
    queueItemStub,
    InvalidLicenseCharacters,
    LicenseFileNames,
    PrimaryBranchNames,
} from '../src/constants';
import { QueueItem } from '../src/types';

describe('constants', () => {
    describe('IgnoreFileName', () => {
        it('should be the correct ignore file name', () => {
            expect(IgnoreFileName).toBe('.findlignore');
        });
    });

    describe('queueItemStub', () => {
        it('should be a frozen QueueItem with default values', () => {
            expect(queueItemStub.name).toBe('');
            expect(queueItemStub.parent).toBe('');
            expect(queueItemStub.repositoryURL).toBeNull();
            expect(queueItemStub.mainRepositoryURL).toBeNull();
            expect(queueItemStub.licenseUrl).toBeNull();
            expect(queueItemStub.licenseUrlIsValid).toBeNull();
            expect(queueItemStub.licenseIsValid).toBeNull();
        });

        it('should be frozen (immutable)', () => {
            expect(Object.isFrozen(queueItemStub)).toBe(true);
        });

        it('should not allow modification', () => {
            expect(() => {
                (queueItemStub as any).name = 'test';
            }).toThrow();
        });
    });

    describe('InvalidLicenseCharacters', () => {
        it('should contain expected invalid characters', () => {
            expect(InvalidLicenseCharacters).toEqual(['/', "'", '"', ':']);
        });

        it('should be an array of strings', () => {
            expect(Array.isArray(InvalidLicenseCharacters)).toBe(true);
            InvalidLicenseCharacters.forEach((char) => {
                expect(typeof char).toBe('string');
            });
        });
    });

    describe('LicenseFileNames', () => {
        it('should contain common license file names', () => {
            const expectedNames = [
                'LICENSE',
                'LICENSE.txt',
                'license',
                'License',
                'license.md',
                'License.md',
                'LICENSE.md',
                'LICENSE-MIT.txt',
                'license-mit',
            ];

            expect(LicenseFileNames).toEqual(expectedNames);
        });

        it('should include various case variations', () => {
            expect(LicenseFileNames).toContain('LICENSE');
            expect(LicenseFileNames).toContain('license');
            expect(LicenseFileNames).toContain('License');
        });

        it('should include different file extensions', () => {
            expect(LicenseFileNames).toContain('LICENSE.txt');
            expect(LicenseFileNames).toContain('LICENSE.md');
            expect(LicenseFileNames).toContain('license.md');
        });

        it('should include MIT-specific license files', () => {
            expect(LicenseFileNames).toContain('LICENSE-MIT.txt');
            expect(LicenseFileNames).toContain('license-mit');
        });
    });

    describe('PrimaryBranchNames', () => {
        it('should contain main and master branch names', () => {
            expect(PrimaryBranchNames).toEqual(['main', 'master']);
        });

        it('should prioritize main over master', () => {
            expect(PrimaryBranchNames[0]).toBe('main');
            expect(PrimaryBranchNames[1]).toBe('master');
        });

        it('should be an array of strings', () => {
            expect(Array.isArray(PrimaryBranchNames)).toBe(true);
            PrimaryBranchNames.forEach((branch) => {
                expect(typeof branch).toBe('string');
            });
        });
    });
});
