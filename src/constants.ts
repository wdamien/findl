import { QueueItem } from './types';

export const IgnoreFileName = '.findlignore';

export const queueItemStub: QueueItem = Object.freeze({
    name: '',
    parent: '',
    repositoryURL: null,
    mainRepositoryURL: null,
    licenseUrl: null,
    licenseUrlIsValid: null,
    licenseIsValid: null,
});

// Some packages include long strings instead of the actual license.
// Try to filter those out.
export const InvalidLicenseCharacters = ['/', "'", '"', ':'];

export const LicenseFileNames = [
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

export const PrimaryBranchNames = ['main', 'master'];
