import async from 'async';
import * as cliProgress from 'cli-progress';
import colors from 'colors/safe';
import * as fs from 'fs-extra';
import packageJson from 'package-json';
import * as path from 'path';
import { PackageJson } from 'type-fest';
import * as yamljs from 'yamljs';
import yargs from 'yargs';
import fetch from 'node-fetch';
import { PubspecFile, PubspecFileError } from './DartDeps';
import {
    noop,
    npmDepsToPaths,
    ping,
    prettyGitURL,
    safeURL,
    wait,
} from './Utils';
import { Octokit } from '@octokit/rest';
import { createTokenAuth } from '@octokit/auth-token';
import { glob } from 'glob';
import resolvePackagePath from 'resolve-package-path';
import YAML from 'yaml';
import ignore from 'ignore';
import { URL } from 'url';
import LicenseTypes from './licenses.json';
import { exit } from 'process';

const IgnoreFileName = '.findlignore';
const result: QueueItem[] = [];

const queueItemStub: QueueItem = Object.freeze({
    name: '',
    parent: '',
    repositoryURL: null,
    mainRepositoryURL: null,
    licenseUrl: null,
    licenseUrlIsValid: null,
});

// Cache the licenses, so we don't have to keep hitting the API.
// Only used for dart / flutter to accommodate how flutter nests its packages.
const dartLicenseCache = new Map<
    string,
    { license?: string; licenseUrl?: string }
>();

let verbose: boolean = false;
let progressBar:
    | cliProgress.SingleBar
    | Pick<cliProgress.SingleBar, 'start' | 'stop' | 'update'>;
let cwd: string = process.cwd();
let outPath: string;

type QueueItem = {
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
    missingLicenseReason?: 'no-local' | 'no-web' | 'missing-repo';
};

// Some packages include long strings instead of the actual license.
// Try to filter those out.
const InvalidLicenseCharacters = ['/', "'", '"', ':'];

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
const PrimaryBranchNames = ['main', 'master'];

const isValidUrl = (s: string | null) => {
    if (s === null) {
        return false;
    }
    try {
        new URL(s);
        return true;
    } catch (err) {
        return false;
    }
};

const wrapInMarkdownUrl = (url: string | null, text?: string) => {
    if (isValidUrl(url)) {
        return `[${text ?? url}](${url})`;
    }
    return url;
};

const validateLicenseName = (value: string | undefined) => {
    const l = LicenseTypes.some((l) => value?.includes(l)) ? value : undefined;
    if (!l && InvalidLicenseCharacters.some((c) => value?.includes(c))) {
        return undefined;
    }
    return l;
};

let octokit: Octokit;
let useGithubAPI: boolean;

const octokitRestLicensesRequests = new Map<
    string,
    ReturnType<typeof octokit.rest.licenses.getForRepo>
>();
const getLicenseFromRepository = async (repo: string) => {
    let license, licenseUrl;

    if (repo && useGithubAPI) {
        const repoPathMatch = repo.match(
            /^(?:https:\/\/github.com\/|github:)([^/]+\/[^/]+)/
        );
        const repoPath = repoPathMatch ? repoPathMatch[1] : null;

        if (repoPath) {
            const lastSlash = repoPath.lastIndexOf('/');
            const repoName = repoPath.substring(lastSlash + 1);
            const owner = repoPath.substring(0, lastSlash);
            const requestKey = `${owner}/${repoName}`;
            const hasPreviousRequest =
                octokitRestLicensesRequests.has(requestKey);
            let licenseRequest;
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

            const licenseResult = await licenseRequest;

            const licenseResultJSON = licenseResult?.data;
            if ('status' in licenseResult && licenseResult.status !== 200) {
                !hasPreviousRequest &&
                    verbose &&
                    log(
                        colors.yellow(
                            `octokit [${licenseResult.status}] ${
                                licenseResult.response.url
                            } ${JSON.stringify(licenseResult.response.data)}`
                        )
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

// Flutter nests a bunch of core packages, that don't have their own pub.dev page. So we have to manually set them to flutter.
const isFlutterRepo = (queueItem: QueueItem) => {
    return [
        'flutter_localizations',
        'flutter_test',
        'flutter',
        'flutter_web_plugins',
    ].some((p) => p === queueItem.repositoryURL);
};

const processPubspecQueue = async (queueItem: QueueItem, cb: () => void) => {
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

const processNPMQueue = async (queueItem: QueueItem, cb: () => void) => {
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
                      : packageJSON.repository.url
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
            const checks = [
                { cb: checkFSForNPMLicense, url: queueItem.repositoryURL },
                { cb: checkAPIForLicense, url: queueItem.repositoryURL },
                queueItem.mainRepositoryURL !== queueItem.repositoryURL
                    ? {
                          cb: checkAPIForLicense,
                          url: queueItem.mainRepositoryURL,
                      }
                    : null,
                { cb: checkGITHostForLicense, url: queueItem.repositoryURL },
                {
                    cb: checkGITHostForLicense,
                    url: queueItem.mainRepositoryURL,
                },
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

                // Not every method uses parent, but does't hurt to pass.
                const result = await cb(url, queueItem.parent);
                if (result?.license) {
                    queueItem.licenseUrl = result.licenseUrl;
                    queueItem.license = result.license;
                    queueItem.licenseUrlIsValid = true;
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

type LicenseResult = {
    license: string | null;
    licenseUrl: string;
};

const checkFSForNPMLicense = async (
    repositoryURL: string,
    parent: string
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
                licenseFileName
            );
            if (licenseUrl === null) {
                // Couldn't validate the url, so just point to the local one.
                return {
                    licenseUrl: path.join(
                        path.relative(cwd, parent),
                        licenseFileName
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
    repositoryURL: string
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
    repositoryURL: string
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

const packageHash: Record<string, QueueItem> = {};

const pingLicenseURL = async (
    urlToCheck: string,
    tryCount = 0
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
const validateLicenseURL = async (
    repoURL: string,
    license: string
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

        const pingExists = pingRequests.has(urlToCheck);
        let pingRequest;
        if (pingExists === false) {
            pingRequest = pingLicenseURL(urlToCheck);
            pingRequests.set(urlToCheck, pingRequest);
        } else {
            pingRequest = pingRequests.get(urlToCheck);
        }

        const urlExists = await pingRequest;
        // log(queueItem, `Checking url: ${urlToCheck} Exists: ${urlExists}`);
        if (urlExists !== false) {
            return { licenseUrl: urlToCheck, license: null };
        }

        // Wait a bit before trying again. Or Github will rate limit us.
        await wait(200);
    }

    return null;
};

const formatMissingReason = (item: QueueItem) => {
    switch (item.missingLicenseReason) {
        case 'missing-repo':
            return ' -> Cannot find valid git repository path.';
        case 'no-local':
            return ' -> Cannot find a license on your disk.';
        case 'no-web':
            return ' -> Cannot find a license on the web.';
    }
};
const log = (
    item: QueueItem | Error | string,
    _value: string | object = ''
) => {
    if (verbose !== true) {
        return;
    }

    const value = typeof _value === 'string' ? _value : JSON.stringify(_value);

    if (item instanceof Error) {
        console.error(item.name, item.message);
    } else if (typeof item === 'string') {
        console.log(`${item}: ${value}`);
    } else {
        console.log(`${item.name}: ${value}`);
    }
};

enum DependencyType {
    npm = 'npm',
    yarnBerry = 'yarnBerry',
    dart = 'dart',
}

const findProjectType = async () => {
    const supportedTypes = [
        {
            type: DependencyType.yarnBerry,
            anchorFile: '.yarnrc.yml',
            createDependencyList: getYarnBerryDeps,
            processor: processNPMQueue,
        },
        {
            type: DependencyType.npm,
            anchorFile: 'package.json',
            createDependencyList: getNPMdeps,
            processor: processNPMQueue,
        },
        {
            type: DependencyType.dart,
            anchorFile: 'pubspec.yaml',
            createDependencyList: getDartDeps,
            processor: processPubspecQueue,
        },
    ];

    for (let i = 0; i < supportedTypes.length; i++) {
        const element = supportedTypes[i];
        if (await fs.pathExists(path.join(cwd, element.anchorFile))) {
            return element;
        }
    }

    return null;
};

const loadIgnoreFile = () => {
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

export const run = async () => {
    const argv = await yargs(process.argv.slice(2)).options({
        deep: { type: 'boolean', default: false },
        verbose: { type: 'boolean', default: false },
        cwd: { type: 'string', default: process.cwd() },
    }).argv;

    const logDeep = argv.deep === true;

    verbose = argv.verbose === true;
    cwd = argv.cwd;
    outPath = path.join(cwd, 'installed-packages.md');

    const projectType = await findProjectType();

    if (projectType === null) {
        console.log(
            colors.bold(
                colors.red('No supported dependencies file found. Exiting.')
            )
        );
        return;
    }

    console.log(
        colors.bold(colors.green(`Found a ${projectType.type} project.`))
    );

    const ignorePatterns = loadIgnoreFile();

    const octokitLog = {
        debug: (message: string) => {},
        info: (message: string) => {},
        warn: (message: string) => {},
        error: (message: string) => {},
    };

    const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
    if (GITHUB_TOKEN) {
        const auth = createTokenAuth(GITHUB_TOKEN);
        const authentication = await auth();
        octokit = new Octokit({ auth: authentication.token, log: octokitLog });
    } else {
        octokit = new Octokit({ log: octokitLog });
    }

    let requestLimit = await octokit.rateLimit.get().catch((e) => {
        console.log(
            colors.bold(colors.yellow('*** Invalid GITHUB_TOKEN.  Ignoring...'))
        );
        return null;
    });

    if (requestLimit === null) {
        requestLimit = await octokit.rateLimit.get();
    }

    if (requestLimit.status === 200) {
        const { limit, remaining, reset } = requestLimit.data.resources.core;
        const refreshDate = new Date(reset * 1000);

        useGithubAPI = remaining > 0;

        console.log(
            colors.yellow(
                `You have ${remaining} Github api requests left. They'll reset to ${limit} at ${refreshDate.toLocaleDateString()} ${refreshDate.toLocaleTimeString()}`
            )
        );

        if (!GITHUB_TOKEN) {
            console.log(
                colors.white(
                    "Hint: If you set a GITHUB_TOKEN env. You'll get more requests (and more accurate results)."
                )
            );
        }
    } else {
        useGithubAPI = false;
        console.log(colors.red('Error connecting to the GitHub api.'));
    }

    const processingQueue: async.QueueObject<QueueItem> = async.queue(
        projectType.processor,
        4
    );
    processingQueue.drain(() => {
        progressBar.stop();

        fs.writeFile(
            outPath,
            result
                .sort((a, b) => {
                    return a.name < b.name ? -1 : 1;
                })
                .map((q) => {
                    const hasBrackets = q.license?.indexOf('(') === 0;
                    return `##### **${q.name} ${!hasBrackets ? '(' : ''}${
                        q.license ?? 'no license found'
                    }${!hasBrackets ? ')' : ''}**\n${[
                        q.description,
                        wrapInMarkdownUrl(q.repositoryURL),
                        wrapInMarkdownUrl(q.licenseUrl),
                    ]
                        .filter(
                            (l) => l !== null && l !== undefined && l !== ''
                        )
                        .join('\n')}`;
                })
                .join('\n\n')
        );
        const successful = result.filter((q) => q.license);
        const unsuccessful = result.filter((q) => !q.license);

        const successfulCount = successful.length;
        const unsuccessfulCount = unsuccessful.length;
        const total = successfulCount + unsuccessfulCount;

        console.log(colors.bold(colors.green(`\nSaved to: ${outPath}`)));
        console.log(colors.green(`Processed ${total} packages.`));

        if (total !== successfulCount) {
            console.log(colors.yellow(`Found ${successfulCount} licenses.`));
        } else {
            console.log(colors.green('Found licenses for all the packages.'));
        }

        if (unsuccessfulCount > 0) {
            console.log(
                colors.bold(
                    colors.red(`Can\'t find ${unsuccessfulCount} licenses!`)
                )
            );
            const missingPackages =
                '\t' +
                unsuccessful
                    .map(
                        (l) =>
                            `${l.name}${
                                l.missingLicenseReason
                                    ? formatMissingReason(l)
                                    : ''
                            }\n\t\trepo url: ${
                                l.repositoryURL
                            }\n\t\tlicense url: ${l.licenseUrl}`
                    )
                    .join('\n\t');
            console.log(missingPackages);
        }
    });

    progressBar = verbose
        ? { start: noop, update: noop, stop: noop }
        : new cliProgress.SingleBar(
              { clearOnComplete: true },
              cliProgress.Presets.shades_classic
          );

    const ignored: string[] = [];
    const deps: QueueItem[] = (
        await projectType.createDependencyList(logDeep)
    ).filter((qi) => {
        if (ignorePatterns.ignores(qi.name)) {
            ignored.push(qi.name);
            return false;
        }
        return true;
    });

    if (ignore.length > 0) {
        console.log(
            colors.yellow(
                `Ignoring ${ignored.length} packages:\n\t${ignored.join(
                    '\n\t'
                )}`
            )
        );
    }

    if (deps && deps.length > 0) {
        processingQueue.push(deps);
        console.log(colors.yellow(`Processing ${deps.length} packages.`));
        progressBar.start(deps.length, 0);
    } else {
        console.log(colors.bold(colors.red('No dependencies found. Exiting.')));
    }
};

const getDartDeps = async () => {
    return new Promise<QueueItem[]>((resolve, reject) => {
        const queueItems: QueueItem[] = [];
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

const getNPMdeps = async (logDeep: boolean) => {
    const deps: string[] | null = await npmDepsToPaths(cwd, logDeep);
    if (deps === null) {
        return [];
    }

    const queueItems: QueueItem[] = [];

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
const getYarnBerryDeps = async () => {
    const yarnRC = YAML.parse(
        fs.readFileSync(path.join(cwd, '.yarnrc.yml'), 'utf8')
    );
    if (yarnRC.nodeLinker !== 'node-modules') {
        console.log(
            colors.bold(colors.red('** We only support node-modules.'))
        );
        return [];
    }
    const queueItems: QueueItem[] = [];
    // Package name id & versions.
    const currentPackages = new Map<string, Set<string>>();
    const packageJsons = await glob('**/package.json', {
        ignore: '**/node_modules/**',
        cwd,
    });
    packageJsons.forEach((jsonBasePath: string) => {
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
                        path.dirname(resolvedJsonPath)
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

run();
