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
import { noop, npmDepsToPaths, ping, prettyGitURL, safeURL } from './Utils';
import { Octokit } from '@octokit/rest';
import { createTokenAuth } from '@octokit/auth-token';
import { glob } from 'glob';
import resolvePackagePath from 'resolve-package-path';
import YAML from 'yaml';

const result: QueueItem[] = [];


let verbose: boolean = false;
let progressBar: cliProgress.SingleBar | Pick<cliProgress.SingleBar, 'start' | 'stop' | 'update'>;
let cwd: string = process.cwd();
let outPath: string;

type QueueItem = {
    name: string;
    parent: string;
    repositoryURL: string | null;
    license?:string;
    description?: string;
    licenseUrl: string | null;
    licenseUrlIsValid: boolean | null;
    missingLicenseReason?: 'no-local' | 'no-web' | 'missing-repo';
};

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

let octokit: Octokit;

const postCommandLog: string[] = [];
let useGithubAPI: boolean;

const getRepoLicense = async (repo: string) => {
    let license, licenseUrl;

    if (repo && useGithubAPI) {
        const repoPathMatch = repo.match(/^(?:https:\/\/github.com\/|github:)([^/]+\/[^/]+)/);
        const repoPath = repoPathMatch ? repoPathMatch[1] : null;

        if (repoPath) {
            try {
                const lastSlash = repoPath.lastIndexOf('/');
                const repoName = repoPath.substring(lastSlash+1);
                const owner = repoPath.substr(0, lastSlash);
                const licenseResult = await octokit.rest.licenses.getForRepo({owner, repo: repoName}).catch(e => {
                    return e;
                });

                const licenseResultJSON = licenseResult?.data;
                if ('message' in licenseResult) {
                    const message = licenseResult.message;
                    if (!postCommandLog.includes(message)) {
                        postCommandLog.push(message);
                    }
                    useGithubAPI = false;
                } else if (licenseResultJSON && licenseResultJSON.license) {
                    licenseUrl = licenseResultJSON.download_url;
                    if (licenseResultJSON.license.spdx_id !== 'NOASSERTION') {
                        license = licenseResultJSON.license.spdx_id;
                    }
                }
            } catch (e) {
                // Oh well.
            }
        }
    }

    return { license, licenseUrl };
};

const processPubspecQueue = async (queueItem: QueueItem, cb: () => void) => {
    let pubspecFile: PubspecFile | null = null;

    if (queueItem.repositoryURL?.indexOf('http') !== 0) {
        pubspecFile = await fetch(`https://pub.dev/api/packages/${queueItem.name}`)
            .then((response) => response.json() as PromiseLike<PubspecFile | PubspecFileError>)
            .then((json) => {
                if ('error' in json) {
                    return null;
                }
                return json;
            });
    } else if (queueItem.repositoryURL === 'flutter') {
        queueItem.repositoryURL = 'https://github.com/flutter/flutter/';
    }

    const pubspec = pubspecFile?.latest.pubspec;

    if (pubspec) {
        queueItem.repositoryURL = pubspec.repository ?? pubspec.homepage ?? queueItem.repositoryURL ?? null;
        queueItem.name = pubspec.name;
        queueItem.description = pubspec.description;
    }

    if (queueItem.repositoryURL) {
        const licenseData = await getRepoLicense(queueItem.repositoryURL);
        queueItem.license = licenseData.license ?? undefined;
        queueItem.licenseUrl = licenseData.licenseUrl ?? queueItem.licenseUrl ?? null;

        // The API never gave us a URL, so look for one.
        if (!queueItem.licenseUrl) {
            for (let i = 0; i < LicenseFileNames.length; i++) {
                const license = LicenseFileNames[i];
                if (await validateLicenseURL(queueItem, license)) {
                    break;
                }
            }
        } else {
            queueItem.licenseUrlIsValid = true;
        }
    }
    
    // Some repos don't have their licenses setup correctly (so the API can load it), so try to scrape the pub.dev page to find it.
    if (!queueItem.license) {
        const html = await fetch(`https://pub.dev/packages/${queueItem.name}`).catch(e => null);
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
                'Unlicense'
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
        queueItem.license = packageJSON.license;

        queueItem.repositoryURL = packageJSON.repository
            ? prettyGitURL(
                  typeof packageJSON.repository === 'string' ? packageJSON.repository : packageJSON.repository.url
              )
            : null;
        
            // Monorepos might include a "directory" value, it points to the actual location of the source.
            if ((packageJSON?.repository as any)?.directory) {
                // Assume its in /blob/main/ some older repos might still user master, but this will catch more.
                queueItem.repositoryURL = queueItem.repositoryURL + '/blob/main/' + (packageJSON?.repository as any)?.directory;
            }

        const repoPieces = safeURL(queueItem.repositoryURL || '');

        // Missing the repo url, so try to load its details from npm.
        if (repoPieces.protocol === null) {
            const npmData = await packageJson(queueItem.name, { fullMetadata: true }).catch(e => null);
            if (npmData?.repository) {
                queueItem.repositoryURL = prettyGitURL(npmData.repository.url);
            }
        }

        if (queueItem.repositoryURL) {
            // Case matters here. So we manually do a strict equality check to see if the file exists.
            const parentContents = await fs.readdirSync(queueItem.parent);

            for (let i = 0; i < LicenseFileNames.length; i++) {
                const license = LicenseFileNames[i];
                const pathExists = parentContents.some((p) => p === license);

                if (pathExists) {
                    if (!(await validateLicenseURL(queueItem, license))) {
                        // Couldn't validate the url, so just point to the local one.
                        queueItem.licenseUrl = path.join(path.relative(cwd, queueItem.parent), license);
                    }
                    break;
                }
            }

            // No local license was found :/, so check the web.
            if (queueItem.licenseUrlIsValid === null) {
                log(queueItem, 'No local license was found. checking the web.');

                const repoLicense = await getRepoLicense(queueItem.repositoryURL);
                if (repoLicense.license && repoLicense.licenseUrl) {
                    queueItem.licenseUrlIsValid = true;
                    queueItem.licenseUrl = repoLicense.licenseUrl;
                    queueItem.license = repoLicense.license;
                }

                if (!queueItem.licenseUrlIsValid) {
                    for (let i = 0; i < LicenseFileNames.length; i++) {
                        const license = LicenseFileNames[i];
                        // Some urls will have not protocol, so add on https as needed.
                        queueItem.licenseUrl?.indexOf('https://') === 0 || queueItem.licenseUrl?.indexOf('node_modules') === 0
                            ? queueItem.licenseUrl
                            : 'https://' + queueItem.licenseUrl;

                        if (await validateLicenseURL(queueItem, license)) {
                            break;
                        }
                    }
                }

                // Still haven't found a license.
                if (queueItem.licenseUrlIsValid === null) {
                    queueItem.licenseUrlIsValid = false;
                    queueItem.missingLicenseReason = 'no-web';
                    log(queueItem, 'No local license was found.');
                }
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

const packageHash: Record<string, QueueItem> = {};

const validateLicenseURL = async (queueItem: QueueItem, license: string) => {
    if (queueItem.licenseUrlIsValid !== null) {
        return queueItem.licenseUrlIsValid;
    }

    for (let i = 0; i < PrimaryBranchNames.length; i++) {
        const primaryBranch = PrimaryBranchNames[i];
        const urlToCheck =
            PrimaryBranchNames.find((b) => queueItem.repositoryURL?.includes(`/${b}/`)) !== undefined
                ? `${queueItem.repositoryURL}/${license}`
                : // GitLab and GitHub both use blob, whereas bitbucket uses src.
                  `${queueItem.repositoryURL}/${
                      queueItem.repositoryURL?.includes('bitbucket.org') ? 'src' : 'blob'
                  }/${primaryBranch}/${license}`;
        const urlExists = await ping(urlToCheck);
        log(queueItem, `Checking url: ${urlToCheck} Exists: ${urlExists}`);
        if (urlExists !== false) {
            const licenseUrl = typeof urlExists === 'string' ? urlExists : urlToCheck;
            queueItem.licenseUrlIsValid = licenseUrl !== null;
            queueItem.licenseUrl = licenseUrl || license;
            return true;
        }
    }

    return false;
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

const log = (item: QueueItem | Error, value: string = '') => {
    if (verbose !== true) {
        return;
    }

    console.log('\n');
    if (item instanceof Error) {
        console.error(item.name, item.message);
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

export const run = async () => {
    const argv = await yargs(process.argv.slice(2)).options({
        deep: { type: 'boolean', default: false },
        verbose: { type: 'boolean', default: false },
        cwd: { type: 'string', default: process.cwd() },
    }).argv;

    const logDeep = argv.deep === true;

    verbose = argv.verbose === true;
    cwd = argv.cwd;
    outPath = path.join(cwd, 'installed-packages.txt');

    const projectType = await findProjectType();

    if (projectType === null) {
        console.log(colors.bold(colors.red('No supported dependencies file found. Exiting.')));
        return;
    }

    console.log(colors.bold(colors.green(`Found a ${projectType.type} project.`)));

    const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
    if (GITHUB_TOKEN) {
        const auth = createTokenAuth(GITHUB_TOKEN);
        const authentication = await auth();
        octokit = new Octokit({auth: authentication.token});
    } else {
        octokit = new Octokit();
    }
    let requestLimit = await octokit.rateLimit.get().catch(e => {
        console.log(colors.bold(colors.yellow('*** Invalid GITHUB_TOKEN.  Ignoring...')));
        return null;
    });

    if (requestLimit === null) {
        octokit = new Octokit();
        requestLimit = await octokit.rateLimit.get();
    }
    
    if (requestLimit.status === 200) {
        const requestData = requestLimit.data;
        const refreshDate = new Date(requestData.rate.reset + Date.now());

        useGithubAPI = requestData.rate.remaining > 0;
        
        console.log(colors.yellow(`You have ${requestData.rate.remaining} Github api requests left. They'll reset to ${requestData.rate.limit} at ${refreshDate.toLocaleDateString()} ${refreshDate.toLocaleTimeString()}`));
        if (!GITHUB_TOKEN) {
            console.log(colors.white("Hint: If you set a GITHUB_TOKEN env. You'll get more requests (and more accurate results)."));
        }
    } else {
        useGithubAPI = false;
        console.log(colors.red('Error connecting to the GitHub api.'));
    }

    const processingQueue: async.QueueObject<QueueItem> = async.queue(projectType.processor, 4);
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
                    return `${q.name} ${!hasBrackets?'(':''}${q.license ?? 'no license found'}${!hasBrackets?')':''}\n${[
                        q.description,
                        q.repositoryURL,
                        q.licenseUrl,
                    ]
                    .filter((l) => l !== null && l !== undefined && l !== '')
                    .join('\n')}`;
                })
                .join('\n\n')
        );
        const successful = result.filter((q) => q.license);
        const unsuccessful = result.filter((q) => !q.license);

        const successfulCount = successful.length;
        const unsuccessfulCount = unsuccessful.length;
        const total = successfulCount + unsuccessfulCount;

        if (postCommandLog.length > 0) {
            console.log(colors.yellow(postCommandLog.join('\n')));
        }

        console.log(colors.bold(colors.green(`\nSaved to: ${outPath}`)));
        console.log(colors.green(`Processed ${total} packages.`));

        if (total !== successfulCount) {
            console.log(colors.yellow(`Found ${successfulCount} licenses.`));
        } else {
            console.log(colors.green('Found licenses for all the packages.'));
        }

        if (unsuccessfulCount > 0) {
            console.log(colors.bold(colors.red(`Can\'t find ${unsuccessfulCount} licenses!`)));
            const missingPackages = '\t' +
            unsuccessful
                .map((l) => `${l.name}${l.missingLicenseReason ? formatMissingReason(l) : ''}\n\t\trepo url: ${l.repositoryURL}\n\t\tlicense url: ${l.licenseUrl}`)
                .join('\n\t');
            console.log(missingPackages);
        }
    });

    progressBar = verbose
        ? { start: noop, update: noop, stop: noop }
        : new cliProgress.SingleBar({ clearOnComplete: true }, cliProgress.Presets.shades_classic);

    const deps: QueueItem[] | null = await projectType.createDependencyList(logDeep);

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
            const dependencies: Record<string, any> = {};

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
                    name: key,
                    parent: '',
                    repositoryURL: value?.git ? prettyGitURL(value.git.url ?? value.git) : key,
                    licenseUrl: null,
                    licenseUrlIsValid: null,
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
        return null;
    }

    const queueItems: QueueItem[] = [];

    deps.forEach((item) => {
        const queueItem: QueueItem = {
            name: item,
            parent: path.join(cwd, 'node_modules', item),
            repositoryURL: null,
            licenseUrl: null,
            licenseUrlIsValid: null,
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
    const yarnRC = YAML.parse(fs.readFileSync(path.join(cwd, '.yarnrc.yml'), 'utf8'));
    if (yarnRC.nodeLinker !== 'node-modules') {
        console.log(colors.bold(colors.red('** We only support node-modules.')));
        return [];
    }
    const queueItems: QueueItem[] = [];
    // Package name id & versions.
    const currentPackages = new Map<string, Set<string>>();
    const packageJsons = await glob('**/package.json', { ignore: '**/node_modules/**' });
    packageJsons.forEach((jsonPath) => {
        // Parse out dependencies.
        const json = JSON.parse(fs.readFileSync(path.resolve('./', jsonPath), 'utf8'));
        for (const key in json.dependencies) {
            if (key in json.dependencies) {
                const version = json.dependencies[key];
                if (!currentPackages.has(key)) {
                    currentPackages.set(key, new Set());
                    const modulePackageJSONPath = resolvePackagePath(key, path.dirname(jsonPath));
                    if (modulePackageJSONPath) {
                        const queueItem: QueueItem = {
                            name: key,
                            parent: path.dirname(modulePackageJSONPath),
                            repositoryURL: null,
                            licenseUrl: null,
                            licenseUrlIsValid: null,
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
