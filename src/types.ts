import * as cliProgress from 'cli-progress';

export type QueueItem = {
    // Name from the package.json
    name: string;

    // Parent folder on the disk
    parent: string;

    // The main repository url.
    repositoryURL: string | null;

    // The top level repository.
    mainRepositoryURL: string | null;
    license?: string;
    description?: string;
    licenseUrl: string | null;
    licenseUrlIsValid: boolean | null;
    licenseIsValid: boolean | null;
    missingLicenseReason?: 'no-local' | 'no-web' | 'missing-repo';
};

export type LicenseResult = {
    license: string | null;
    licenseUrl: string;
};

export enum DependencyType {
    npm = 'npm',
    yarnBerry = 'yarnBerry',
    dart = 'dart',
}

export type ProjectType = {
    type: DependencyType;
    anchorFile: string;
    createDependencyList: (logDeep?: boolean) => Promise<QueueItem[]>;
    processor: (queueItem: QueueItem, cb: () => void) => Promise<void>;
};

export type ProgressBar = Pick<
    cliProgress.SingleBar,
    'start' | 'stop' | 'update'
>;
