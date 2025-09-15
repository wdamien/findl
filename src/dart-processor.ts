import * as path from 'path';
import * as yamljs from 'yamljs';
import fetch from 'node-fetch';
import { QueueItem } from './types';
import { queueItemStub } from './constants';
import {
    getLicenseFromRepository,
    validateLicenseURL,
    setCwd,
} from './shared-utils';
import { prettyGitURL } from './Utils';
import { PubspecFile, PubspecFileError } from './DartDeps';

// Cache the licenses, so we don't have to keep hitting the API.
// Only used for dart / flutter to accommodate how flutter nests its packages.
const dartLicenseCache = new Map<
    string,
    { license?: string; licenseUrl?: string }
>();

let cwd: string = process.cwd();
let progressBar: any;
let result: QueueItem[] = [];

export const setDartProcessorCwd = (value: string) => {
    cwd = value;
    setCwd(value);
};

export const setDartProgressBar = (bar: any) => {
    progressBar = bar;
};

export const setDartResult = (res: QueueItem[]) => {
    result = res;
};

// Flutter nests a bunch of core packages, that don't have their own pub.dev page. So we have to manually set them to flutter.
const isFlutterRepo = (queueItem: QueueItem) => {
    return [
        'flutter_localizations',
        'flutter_test',
        'flutter',
        'flutter_web_plugins',
    ].some((p) => p === queueItem.repositoryURL);
};

export const processPubspecQueue = async (
    queueItem: QueueItem,
    cb: () => void
) => {
    let pubspecFile: PubspecFile | null = null;

    if (isFlutterRepo(queueItem)) {
        queueItem.repositoryURL = 'https://github.com/flutter/flutter/';
    } else if (queueItem.repositoryURL?.indexOf('http') !== 0) {
        pubspecFile = await fetch(
            `https://pub.dev/api/packages/${queueItem.name}`
        )
            .then(
                (response) =>
                    response.json().catch((e) => ({
                        error: 'Invalid JSON',
                    })) as PromiseLike<PubspecFile | PubspecFileError>
            )
            .then((json) => {
                if ('error' in json) {
                    return null;
                }
                return json;
            });
    }

    const pubspec = pubspecFile?.latest.pubspec;

    if (pubspec) {
        queueItem.repositoryURL =
            pubspec.repository ??
            pubspec.homepage ??
            queueItem.repositoryURL ??
            null;
        queueItem.name = pubspec.name;
        queueItem.description = pubspec.description;
    }

    if (queueItem.repositoryURL) {
        // We've already checked this repo, so re-use the license.
        if (dartLicenseCache.has(queueItem.repositoryURL)) {
            const cachedLicense = dartLicenseCache.get(queueItem.repositoryURL);
            queueItem.license = cachedLicense?.license ?? '';
            queueItem.licenseUrl = cachedLicense?.licenseUrl ?? '';
        } else {
            const licenseData = await getLicenseFromRepository(
                queueItem.repositoryURL
            );
            queueItem.license = licenseData?.license ?? undefined;
            queueItem.licenseUrl =
                licenseData?.licenseUrl ?? queueItem.licenseUrl ?? null;
            // The API never gave us a URL, so look for one.
            if (!queueItem.licenseUrl) {
                const LicenseFileNames = [
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
                for (let i = 0; i < LicenseFileNames.length; i++) {
                    const licenseFileName = LicenseFileNames[i];
                    const licenseResult = await validateLicenseURL(
                        queueItem.repositoryURL,
                        licenseFileName
                    );
                    if (licenseResult !== null) {
                        queueItem.licenseUrl = licenseResult.licenseUrl;
                        queueItem.license = licenseResult.license ?? undefined;
                        break;
                    }
                }
            } else {
                queueItem.licenseUrlIsValid = true;
                dartLicenseCache.set(queueItem.repositoryURL, {
                    license: queueItem.license,
                    licenseUrl: queueItem.licenseUrl,
                });
            }
        }
    }

    // Some repos don't have their licenses setup correctly (so the API can load it), so try to scrape the pub.dev page to find it.
    if (!queueItem.license) {
        const html = await fetch(
            `https://pub.dev/packages/${queueItem.name}`
        ).catch((e) => null);
        if (html) {
            const licensesToCheck = [
                'MIT',
                'BSD-3-Clause',
                'BSD-2-Clause',
                'Apache-2.0',
                'AGPL-3.0-or-later',
                'AGPL-3.0-only',
                'GPL-3.0-or-later',
                'GPL-3.0-only',
                'LGPL-3.0-or-later',
                'LGPL-3.0-only',
                'MPL-2.0',
                'BSL-1.0',
                'Unlicense',
            ];
            const htmlString = await html.text();
            for (let i = 0; i < licensesToCheck.length; i++) {
                const license = licensesToCheck[i];
                if (new RegExp(`\\b${license}\\b`, 'g').test(htmlString)) {
                    queueItem.license = license;
                    break;
                }
            }
        }
    }

    result.push(queueItem);
    progressBar.update(result.length);

    cb();
};

export const getDartDeps = async () => {
    return new Promise<QueueItem[]>((resolve, reject) => {
        const queueItems: QueueItem[] = [];
        const packageHash: Record<string, QueueItem> = {};

        yamljs.load(path.join(cwd, 'pubspec.yaml'), (pubspec) => {
            const dependencies: Record<
                string,
                { git?: { url?: string } | string }
            > = {};

            for (const key in pubspec.builders) {
                dependencies[key] = pubspec.builders[key];
            }
            for (const key in pubspec.dependencies) {
                dependencies[key] = pubspec.dependencies[key];
            }
            for (const key in pubspec.dev_dependencies) {
                dependencies[key] = pubspec.dev_dependencies[key];
            }

            const dependenciesList = Object.entries(dependencies);
            dependenciesList.forEach(([key, value]) => {
                const queueItem: QueueItem = {
                    ...queueItemStub,
                    name: key,
                    repositoryURL: value?.git
                        ? typeof value.git === 'string'
                            ? value.git
                            : value.git.url
                            ? prettyGitURL(value.git.url)
                            : ''
                        : key,
                };

                if (!(queueItem.name in packageHash)) {
                    queueItems.push(queueItem);
                    packageHash[queueItem.name] = queueItem;
                }
            });

            resolve(queueItems);
        });
    });
};
