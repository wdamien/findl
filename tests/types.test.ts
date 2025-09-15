import { describe, it, expect } from 'vitest';
import {
    QueueItem,
    LicenseResult,
    DependencyType,
    ProjectType,
} from '../src/types';

describe('types', () => {
    describe('QueueItem', () => {
        it('should allow creating a valid QueueItem', () => {
            const queueItem: QueueItem = {
                name: 'test-package',
                parent: '/path/to/parent',
                repositoryURL: 'https://github.com/user/repo',
                mainRepositoryURL: 'https://github.com/user/main-repo',
                license: 'MIT',
                description: 'A test package',
                licenseUrl: 'https://github.com/user/repo/blob/main/LICENSE',
                licenseUrlIsValid: true,
                licenseIsValid: true,
                missingLicenseReason: 'no-local',
            };

            expect(queueItem.name).toBe('test-package');
            expect(queueItem.parent).toBe('/path/to/parent');
            expect(queueItem.repositoryURL).toBe(
                'https://github.com/user/repo'
            );
            expect(queueItem.mainRepositoryURL).toBe(
                'https://github.com/user/main-repo'
            );
            expect(queueItem.license).toBe('MIT');
            expect(queueItem.description).toBe('A test package');
            expect(queueItem.licenseUrl).toBe(
                'https://github.com/user/repo/blob/main/LICENSE'
            );
            expect(queueItem.licenseUrlIsValid).toBe(true);
            expect(queueItem.licenseIsValid).toBe(true);
            expect(queueItem.missingLicenseReason).toBe('no-local');
        });

        it('should allow null values for optional fields', () => {
            const queueItem: QueueItem = {
                name: 'test-package',
                parent: '/path/to/parent',
                repositoryURL: null,
                mainRepositoryURL: null,
                licenseUrl: null,
                licenseUrlIsValid: null,
                licenseIsValid: null,
            };

            expect(queueItem.repositoryURL).toBeNull();
            expect(queueItem.mainRepositoryURL).toBeNull();
            expect(queueItem.licenseUrl).toBeNull();
            expect(queueItem.licenseUrlIsValid).toBeNull();
            expect(queueItem.licenseIsValid).toBeNull();
            expect(queueItem.license).toBeUndefined();
            expect(queueItem.description).toBeUndefined();
            expect(queueItem.missingLicenseReason).toBeUndefined();
        });

        it('should support all missing license reason types', () => {
            const reasons: Array<QueueItem['missingLicenseReason']> = [
                'no-local',
                'no-web',
                'missing-repo',
                undefined,
            ];

            reasons.forEach((reason) => {
                const queueItem: QueueItem = {
                    name: 'test-package',
                    parent: '/path/to/parent',
                    repositoryURL: null,
                    mainRepositoryURL: null,
                    licenseUrl: null,
                    licenseUrlIsValid: null,
                    licenseIsValid: null,
                    missingLicenseReason: reason,
                };

                expect(queueItem.missingLicenseReason).toBe(reason);
            });
        });
    });

    describe('LicenseResult', () => {
        it('should allow creating a valid LicenseResult with license', () => {
            const licenseResult: LicenseResult = {
                license: 'MIT',
                licenseUrl: 'https://github.com/user/repo/blob/main/LICENSE',
            };

            expect(licenseResult.license).toBe('MIT');
            expect(licenseResult.licenseUrl).toBe(
                'https://github.com/user/repo/blob/main/LICENSE'
            );
        });

        it('should allow null license', () => {
            const licenseResult: LicenseResult = {
                license: null,
                licenseUrl: 'https://github.com/user/repo/blob/main/LICENSE',
            };

            expect(licenseResult.license).toBeNull();
            expect(licenseResult.licenseUrl).toBe(
                'https://github.com/user/repo/blob/main/LICENSE'
            );
        });
    });

    describe('DependencyType', () => {
        it('should have npm type', () => {
            expect(DependencyType.npm).toBe('npm');
        });

        it('should have yarnBerry type', () => {
            expect(DependencyType.yarnBerry).toBe('yarnBerry');
        });

        it('should have dart type', () => {
            expect(DependencyType.dart).toBe('dart');
        });

        it('should contain all expected dependency types', () => {
            const expectedTypes = ['npm', 'yarnBerry', 'dart'];
            const actualTypes = Object.values(DependencyType);

            expect(actualTypes).toEqual(expectedTypes);
            expect(actualTypes).toHaveLength(3);
        });
    });

    describe('ProjectType', () => {
        it('should allow creating a valid ProjectType', () => {
            const mockCreateDependencyList = async () => [];
            const mockProcessor = async () => {};

            const projectType: ProjectType = {
                type: DependencyType.npm,
                anchorFile: 'package.json',
                createDependencyList: mockCreateDependencyList,
                processor: mockProcessor,
            };

            expect(projectType.type).toBe(DependencyType.npm);
            expect(projectType.anchorFile).toBe('package.json');
            expect(typeof projectType.createDependencyList).toBe('function');
            expect(typeof projectType.processor).toBe('function');
        });

        it('should work with all dependency types', () => {
            const mockCreateDependencyList = async () => [];
            const mockProcessor = async () => {};

            const npmProject: ProjectType = {
                type: DependencyType.npm,
                anchorFile: 'package.json',
                createDependencyList: mockCreateDependencyList,
                processor: mockProcessor,
            };

            const yarnBerryProject: ProjectType = {
                type: DependencyType.yarnBerry,
                anchorFile: '.yarnrc.yml',
                createDependencyList: mockCreateDependencyList,
                processor: mockProcessor,
            };

            const dartProject: ProjectType = {
                type: DependencyType.dart,
                anchorFile: 'pubspec.yaml',
                createDependencyList: mockCreateDependencyList,
                processor: mockProcessor,
            };

            expect(npmProject.type).toBe(DependencyType.npm);
            expect(yarnBerryProject.type).toBe(DependencyType.yarnBerry);
            expect(dartProject.type).toBe(DependencyType.dart);
        });

        it('should have function signatures that match expected behavior', async () => {
            const mockQueueItems: QueueItem[] = [
                {
                    name: 'test-package',
                    parent: '/test',
                    repositoryURL: null,
                    mainRepositoryURL: null,
                    licenseUrl: null,
                    licenseUrlIsValid: null,
                    licenseIsValid: null,
                },
            ];

            const mockCreateDependencyList = async (logDeep?: boolean) => {
                expect(
                    logDeep === undefined || typeof logDeep === 'boolean'
                ).toBe(true);
                return mockQueueItems;
            };

            const mockProcessor = async (
                queueItem: QueueItem,
                cb: () => void
            ) => {
                expect(queueItem).toBeDefined();
                expect(typeof cb).toBe('function');
                cb();
            };

            const projectType: ProjectType = {
                type: DependencyType.npm,
                anchorFile: 'package.json',
                createDependencyList: mockCreateDependencyList,
                processor: mockProcessor,
            };

            // Test createDependencyList
            const result = await projectType.createDependencyList(true);
            expect(result).toEqual(mockQueueItems);

            // Test processor
            let callbackCalled = false;
            await projectType.processor(mockQueueItems[0], () => {
                callbackCalled = true;
            });
            expect(callbackCalled).toBe(true);
        });
    });
});
