import type { Octokit } from '@octokit/rest';
import colors from 'colors/safe';
import * as fs from 'fs-extra';
import ignore from 'ignore';
import * as path from 'path';
import { URL } from 'url';
import {
    IgnoreFileName,
    InvalidLicenseCharacters,
    PrimaryBranchNames,
} from './constants';
import LicenseTypes from './licenses.json';
import { LicenseResult, ProjectType, QueueItem } from './types';
import { ping, wait } from './Utils';

let verbose = false;
let cwd: string = process.cwd();
let octokit: Octokit;
let useGithubAPI: boolean;

export const setVerbose = (value: boolean) => {
    verbose = value;
};

export const setCwd = (value: string) => {
    cwd = value;
};

export const setOctokit = (value: Octokit) => {
    octokit = value;
};

export const setUseGithubAPI = (value: boolean) => {
    useGithubAPI = value;
};

export const isValidUrl = (s: string | null): s is string => {
    if (s === null) {
        return false;
    }
    try {
        new URL(s);
        return true;
    } catch (_: unknown) {
        return false;
    }
};

export const wrapInMarkdownUrl = (url: string | null, text?: string) => {
    if (isValidUrl(url)) {
        return `[${text ?? url}](${url})`;
    }
    return url;
};

export const validateLicenseName = (value: string | undefined) => {
    const l = LicenseTypes[(value as keyof typeof LicenseTypes) ?? '']
        ? value
        : undefined;
    if (!l && InvalidLicenseCharacters.some((c) => value?.includes(c))) {
        return undefined;
    }
    return l;
};

const octokitRestLicensesRequests = new Map<
    string,
    ReturnType<typeof octokit.rest.licenses.getForRepo>
>();

export const getLicenseFromRepository = async (repo: string) => {
    let license: string | null = null;
    let licenseUrl: string | null = null;

    if (repo && useGithubAPI) {
        const repoPathMatch = repo.match(
            /^(?:https:\/\/github.com\/|github:)([^/]+\/[^/]+)/,
        );
        const repoPath = repoPathMatch ? repoPathMatch[1] : null;

        if (repoPath) {
            const lastSlash = repoPath.lastIndexOf('/');
            const repoName = repoPath.substring(lastSlash + 1);
            const owner = repoPath.substring(0, lastSlash);
            const requestKey = `${owner}/${repoName}`;
            const hasPreviousRequest =
                octokitRestLicensesRequests.has(requestKey);
            let licenseRequest:
                | ReturnType<typeof octokit.rest.licenses.getForRepo>
                | undefined;
            if (hasPreviousRequest === false) {
                licenseRequest = octokit.rest.licenses
                    .getForRepo({ owner, repo: repoName })
                    .catch((e) => {
                        return e;
                    });
                octokitRestLicensesRequests.set(requestKey, licenseRequest);
            } else {
                licenseRequest = octokitRestLicensesRequests.get(requestKey);
            }

            if (!licenseRequest) {
                throw new Error('Missing licenseRequest');
            }

            const licenseResult = await licenseRequest;

            const licenseResultJSON = licenseResult?.data;
            if (
                licenseResultJSON &&
                'status' in licenseResult &&
                licenseResult.status !== 200
            ) {
                !hasPreviousRequest &&
                    verbose &&
                    log(
                        colors.yellow(
                            `octokit [${licenseResult.status}] ${
                                licenseResult.url
                            } ${JSON.stringify(licenseResultJSON)}`,
                        ),
                    );
            } else if (licenseResultJSON && licenseResultJSON.license) {
                licenseUrl = licenseResultJSON.html_url;
                if (licenseResultJSON.license.spdx_id !== 'NOASSERTION') {
                    license = licenseResultJSON.license.spdx_id;
                }
            }
        }
    }

    return { license, licenseUrl };
};

const pingLicenseURL = async (
    urlToCheck: string,
    tryCount = 0,
): Promise<string | boolean> => {
    const { result, status } = await ping(urlToCheck);
    if (typeof result === 'string') {
        return pingLicenseURL(result, tryCount + 1);
    } else if (result === false && status === 429 && tryCount < 3) {
        await wait(2000);
        return pingLicenseURL(urlToCheck, tryCount + 1);
    }
    return result;
};

const pingRequests = new Map<string, ReturnType<typeof pingLicenseURL>>();

export const validateLicenseURL = async (
    repoURL: string,
    license: string,
): Promise<LicenseResult | null> => {
    for (let i = 0; i < PrimaryBranchNames.length; i++) {
        const primaryBranch = PrimaryBranchNames[i];
        const urlToCheck =
            PrimaryBranchNames.find((b) => repoURL?.includes(`/${b}/`)) !==
            undefined
                ? `${repoURL}/${license}`
                : // GitLab and GitHub both use blob, whereas bitbucket uses src.
                  `${repoURL}/${
                      repoURL?.includes('bitbucket.org') ? 'src' : 'blob'
                  }/${primaryBranch}/${license}`;

        if (
            !(
                urlToCheck.startsWith('https://') ||
                urlToCheck.startsWith('https://')
            )
        ) {
            continue;
        }

        const pingExists = pingRequests.has(urlToCheck);
        let pingRequest;
        if (pingExists === false) {
            pingRequest = pingLicenseURL(urlToCheck);
            pingRequests.set(urlToCheck, pingRequest);
        } else {
            pingRequest = pingRequests.get(urlToCheck);
        }

        const urlExists = await pingRequest;
        // log(`Checking url: ${urlToCheck} Exists: ${urlExists}`);
        if (urlExists !== false) {
            return { licenseUrl: urlToCheck, license: null };
        }

        // Wait a bit before trying again. Or Github will rate limit us.
        await wait(200);
    }

    return null;
};

export const formatMissingReason = (item: QueueItem) => {
    switch (item.missingLicenseReason) {
        case 'missing-repo':
            return ' -> Cannot find valid git repository path.';
        case 'no-local':
            return ' -> Cannot find a license on your disk.';
        case 'no-web':
            return ' -> Cannot find a license on the web.';
    }
};

enum LicenseWarningLevel {
    none = 'none',
    high = 'high',
    attribution = 'attribution',
    critical = 'critical',
}

export const validateLicenses = (items: QueueItem[]) => {
    const warnings: Record<LicenseWarningLevel, QueueItem[]> = {
        [LicenseWarningLevel.none]: [],
        [LicenseWarningLevel.attribution]: [],
        [LicenseWarningLevel.critical]: [],
        [LicenseWarningLevel.high]: [],
    };
    items.forEach((l) => {
        if (l.license) {
            const type = LicenseTypes[l.license as keyof typeof LicenseTypes];
            type && warnings[type.warningLevel as LicenseWarningLevel].push(l);
        }
    });

    const noneCount = warnings[LicenseWarningLevel.none].length;
    const attributionCount = warnings[LicenseWarningLevel.attribution].length;
    const highCount = warnings[LicenseWarningLevel.high].length;
    const criticalCount = warnings[LicenseWarningLevel.critical].length;

    const messages = [];

    if (noneCount > 0) {
        messages.push(
            colors.green(
                `✅  Found ${noneCount} packages that are safe to use.\n`,
            ),
        );
    }

    if (attributionCount > 0) {
        messages.push(
            colors.yellow(
                `✏️  Found ${attributionCount} packages that may require attribution in your app.\n\t${warnings[LicenseWarningLevel.attribution].map((w) => `${w.name} (${w.license})`).join('\n\t')}\n`,
            ),
        );
    }

    if (highCount > 0) {
        messages.push(
            colors.yellow(
                `⚠️  Found ${highCount} warnings. Verify these are safe to use.\n\t${warnings[LicenseWarningLevel.high].map((w) => w.name).join('\n\t')}\n`,
            ),
        );
    }

    if (criticalCount > 0) {
        messages.push(
            colors.bold(
                colors.red(
                    `‼️‼️‼️  Found ${criticalCount} critical packages! Get legal approval before using them. ‼️‼️‼️\n\t${warnings[LicenseWarningLevel.critical].map((w) => `${w.name} (${w.license})`).join('\n\t')}\n`,
                ),
            ),
        );
    }

    if (messages.length > 0) {
        console.warn('\n' + messages.join('\n'));
    }
};

export const log = (
    item: QueueItem | Error | string,
    _value: string | object = '',
) => {
    if (verbose !== true) {
        return;
    }

    const value = typeof _value === 'string' ? _value : JSON.stringify(_value);

    if (item instanceof Error) {
        console.error(item.name, item.message);
    } else if (typeof item === 'string') {
        console.log(colors.gray(` ${item}${value === '' ? '' : `: ${value}`}`));
    } else {
        console.log(colors.gray(` ${item.name}: ${value}`));
    }
};

export const loadIgnoreFile = () => {
    const ignoreFile = path.join(cwd, IgnoreFileName);
    const ig = ignore();
    if (fs.existsSync(ignoreFile)) {
        const ignoreFileContents = fs.readFileSync(ignoreFile, 'utf8');
        const ignoreFileLines = ignoreFileContents.split('\n');
        ig.add(ignoreFileLines);
        return ig;
    }
    return ig;
};

export const findProjectType = async (
    supportedTypes: ProjectType[],
): Promise<ProjectType | null> => {
    for (let i = 0; i < supportedTypes.length; i++) {
        const element = supportedTypes[i];
        if (await fs.pathExists(path.join(cwd, element.anchorFile))) {
            return element;
        }
    }

    return null;
};
