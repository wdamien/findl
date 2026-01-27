import * as fs from 'fs-extra';
import * as path from 'path';
import packageJson from 'package-json';
import { PackageJson } from 'type-fest';
import { glob } from 'glob';
import resolvePackagePath from 'resolve-package-path';
import YAML from 'yaml';
import colors from 'colors/safe';
import { QueueItem, LicenseResult, ProgressBar } from './types';
import { queueItemStub, LicenseFileNames } from './constants';
import {
    validateLicenseName,
    getLicenseFromRepository,
    validateLicenseURL,
    log,
    setCwd,
} from './shared-utils';
import { prettyGitURL, safeURL, npmDepsToPaths } from './Utils';

let cwd: string = process.cwd();
let progressBar: ProgressBar;
let result: QueueItem[] = [];

export const setNodeProcessorCwd = (value: string) => {
    cwd = value;
    setCwd(value);
};

export const setNodeProgressBar = (bar: ProgressBar) => {
    progressBar = bar;
};

export const setNodeResult = (res: QueueItem[]) => {
    result = res;
};

export const processNPMQueue = async (queueItem: QueueItem, cb: () => void) => {
    const packageJsonPath = `${queueItem.parent}/package.json`;
    if (!(await fs.pathExists(packageJsonPath))) {
        queueItem.licenseUrlIsValid = false;
        queueItem.missingLicenseReason = 'no-local';
    } else {
        const packageJSON: PackageJson = await fs.readJSON(packageJsonPath);
        queueItem.description = packageJSON.description;
        queueItem.license = validateLicenseName(packageJSON.license);

        queueItem.mainRepositoryURL = packageJSON.repository
            ? prettyGitURL(
                  typeof packageJSON.repository === 'string'
                      ? packageJSON.repository
                      : packageJSON.repository.url,
              )
            : null;
        queueItem.repositoryURL = queueItem.mainRepositoryURL;

        // Monorepos might include a "directory" value, it points to the actual location of the source.
        const directory =
            typeof packageJSON?.repository !== 'string'
                ? packageJSON?.repository?.directory
                : null;
        if (directory) {
            // Main repo, according to the package.json.
            queueItem.repositoryURL =
                queueItem.repositoryURL + '/blob/main/' + directory;
        }

        const repoPieces = safeURL(queueItem.repositoryURL ?? '');

        // Missing the repo url, so try to load its details from npm.
        if (repoPieces.protocol === null) {
            const npmData = await packageJson(queueItem.name, {
                fullMetadata: true,
            }).catch((e) => null);
            if (npmData?.repository) {
                queueItem.repositoryURL = prettyGitURL(npmData.repository.url);
            }
        }

        if (queueItem.repositoryURL) {
            // Run in variety of lookups to find our license, in ascending order of resource use / likelihood to succeed.
            const hasMainRepoURL =
                queueItem.mainRepositoryURL !== queueItem.repositoryURL;
            const checks = [
                { cb: checkFSForNPMLicense, url: queueItem.repositoryURL },
                { cb: checkAPIForLicense, url: queueItem.repositoryURL },
                hasMainRepoURL
                    ? {
                          cb: checkAPIForLicense,
                          url: queueItem.mainRepositoryURL,
                      }
                    : null,
                { cb: checkGITHostForLicense, url: queueItem.repositoryURL },
                hasMainRepoURL
                    ? {
                          cb: checkGITHostForLicense,
                          url: queueItem.mainRepositoryURL,
                      }
                    : null,
            ];

            for (let i = 0; i < checks.length; i++) {
                const check = checks[i];
                if (check === null) {
                    continue;
                }
                const { url, cb } = check;
                if (!url) {
                    continue;
                }

                // Not every method uses parent, but doesn't hurt to pass.
                const result = await cb(url, queueItem.parent);
                if (result?.licenseUrl) {
                    queueItem.licenseUrl = result.licenseUrl;
                    queueItem.licenseUrlIsValid = true;
                }

                if (result?.license) {
                    queueItem.license = result.license;
                    queueItem.licenseIsValid = true;
                }

                if (queueItem.licenseIsValid && queueItem.licenseUrlIsValid) {
                    break;
                }
            }

            // Still haven't found a license.
            if (queueItem.licenseUrlIsValid === null) {
                queueItem.licenseUrlIsValid = false;
                queueItem.missingLicenseReason = 'no-web';
                log(queueItem, 'No local license was found.');
            }
        } else {
            queueItem.licenseUrlIsValid = false;
            queueItem.missingLicenseReason = 'missing-repo';
        }
    }

    result.push(queueItem);
    progressBar.update(result.length);

    cb();
};

const checkFSForNPMLicense = async (
    repositoryURL: string,
    parent: string,
): Promise<LicenseResult | null> => {
    log('checkFSForNPMLicense', { repositoryURL, parent });
    // Case matters here. So we manually do a strict equality check to see if the file exists.
    const parentContents = await fs.readdirSync(parent);

    for (let i = 0; i < LicenseFileNames.length; i++) {
        const licenseFileName = LicenseFileNames[i];
        const pathExists = parentContents.some((p) => p === licenseFileName);

        if (pathExists) {
            const licenseUrl = await validateLicenseURL(
                repositoryURL,
                licenseFileName,
            );
            if (licenseUrl === null) {
                // Couldn't validate the url, so just point to the local one.
                return {
                    licenseUrl: path.join(
                        path.relative(cwd, parent),
                        licenseFileName,
                    ),
                    license: null,
                };
            } else {
                return licenseUrl;
            }
        }
    }
    return null;
};

const checkAPIForLicense = async (
    repositoryURL: string,
): Promise<LicenseResult | null> => {
    log('checkAPIForLicense', repositoryURL);

    const repoLicense = await getLicenseFromRepository(repositoryURL);
    if (repoLicense.license && repoLicense.licenseUrl) {
        return {
            licenseUrl: repoLicense.licenseUrl,
            license: repoLicense.license,
        };
    }
    return null;
};

const checkGITHostForLicense = async (
    repositoryURL: string,
): Promise<LicenseResult | null> => {
    log('checkGITHostForLicense', repositoryURL);
    for (let i = 0; i < LicenseFileNames.length; i++) {
        const license = LicenseFileNames[i];
        const licenseUrl = await validateLicenseURL(repositoryURL, license);
        if (licenseUrl !== null) {
            return licenseUrl;
        }
    }
    return null;
};

export const getNPMdeps = async (logDeep = false) => {
    const deps: string[] | null = await npmDepsToPaths(cwd, logDeep);
    if (deps === null) {
        return [];
    }

    const queueItems: QueueItem[] = [];
    const packageHash: Record<string, QueueItem> = {};

    deps.forEach((item) => {
        const queueItem: QueueItem = {
            ...queueItemStub,
            name: item,
            parent: path.join(cwd, 'node_modules', item),
        };

        if (!(queueItem.name in packageHash)) {
            queueItems.push(queueItem);
            packageHash[queueItem.name] = queueItem;
        }
    });

    return queueItems;
};

// Only support node_modules for now.
export const getYarnBerryDeps = async () => {
    const yarnRC = YAML.parse(
        fs.readFileSync(path.join(cwd, '.yarnrc.yml'), 'utf8'),
    );
    if (yarnRC.nodeLinker !== 'node-modules') {
        console.log(
            colors.bold(colors.red('** We only support node-modules.')),
        );
        return [];
    }
    const queueItems: QueueItem[] = [];
    // Package name id & versions.
    const currentPackages = new Map<string, Set<string>>();
    const packageJsonList = await glob('**/package.json', {
        ignore: '**/node_modules/**',
        cwd,
    });
    packageJsonList.forEach((jsonBasePath: string) => {
        // Parse out dependencies.
        const resolvedJsonPath = path.resolve(cwd, jsonBasePath);
        const json = JSON.parse(fs.readFileSync(resolvedJsonPath, 'utf8'));
        for (const key in json.dependencies) {
            if (key in json.dependencies) {
                const version = json.dependencies[key];
                if (!currentPackages.has(key)) {
                    currentPackages.set(key, new Set());
                    const modulePackageJSONPath = resolvePackagePath(
                        key,
                        path.dirname(resolvedJsonPath),
                    );
                    if (modulePackageJSONPath) {
                        const queueItem: QueueItem = {
                            ...queueItemStub,
                            name: key,
                            parent: path.dirname(modulePackageJSONPath),
                        };
                        queueItems.push(queueItem);
                    }
                }
                currentPackages.get(key)?.add(version);
            }
        }
    });

    return queueItems;
};
