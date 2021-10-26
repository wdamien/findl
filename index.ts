import * as async from 'async';
import { spawn } from 'child_process';
import cliProgress from 'cli-progress';
import colors from 'colors/safe';
import fs from 'fs-extra';
import * as https from 'https';
import packageJson from 'package-json';
import * as path from 'path';
import { PackageJson } from 'type-fest';
import yargs from 'yargs/yargs';

const result: QueueItem[] = [];
let verbose:boolean = false;
let progressBar:cliProgress.SingleBar | Pick<cliProgress.SingleBar, 'start' | 'stop' | 'update'>;
let cwd:string = process.cwd();
let outPath: string;

type QueueItem = {
    name: string;
    parent: string;
    repositoryURL: string | null;
    package?: PackageJson;
    licenseUrl: string | null;
    licenseUrlIsValid: boolean | null;
    missingLicenseReason?: 'no-local' | 'no-web' | 'missing-repo';
};

const LicenseFileNames = ['LICENSE', 'LICENSE.txt', 'license', 'License', 'license.md', 'License.md', 'LICENSE.md', 'LICENSE-MIT.txt'];
const PrimaryBranchNames = ['master', 'main'];

const prettyGitURL = (repo: string | null) => {
    if (repo) {
        return repo
            .replace('git+', '')
            .replace('git@', 'https://')
            .replace('git://', 'https://')
            .replace('github.com:', 'github.com/')
            .replace('github:', 'github.com/')
            .replace('gitlab.com:', 'gitlab.com/')
            .replace('gitlab:', 'gitlab.com/')
            .replace('bitbucket.org:', 'bitbucket.org/')
            .replace('bitbucket:', 'bitbucket.org/')
            .replace('.git', '');
    }
    return repo;
};

const safeURL = (value: string) => {
    try {
        return new URL(value);
    } catch {
        return {
            hash: null,
            host: null,
            hostname: null,
            href: null,
            origin: null,
            password: null,
            pathname: null,
            port: null,
            protocol: null,
            search: null,
            searchParams: null,
            username: null,
        };
    }
};

const packageHash: Record<string, QueueItem> = {};
const processingQueue = async.queue(async (queueItem: QueueItem, cb: () => void) => {
    const packageJsonPath = `${queueItem.parent}/package.json`;
    if (!(await fs.pathExists(packageJsonPath))) {
        queueItem.licenseUrlIsValid = false;
        queueItem.missingLicenseReason = 'no-local';
    } else {
        const packageJSON: PackageJson = await fs.readJSON(packageJsonPath);
        queueItem.package = packageJSON;

        queueItem.repositoryURL = packageJSON.repository
            ? prettyGitURL(typeof packageJSON.repository === 'string' ? packageJSON.repository : packageJSON.repository.url)
            : null;

        const repoPeices = safeURL(queueItem.repositoryURL || '');
        // Missing the repo url, so try to load its details from npm.
        if (repoPeices.protocol === null) {
            const npmData = await packageJson(queueItem.name, { fullMetadata: true });
            if (npmData.repository) {
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
                for (let i = 0; i < LicenseFileNames.length; i++) {
                    const license = LicenseFileNames[i];

                    // Some urls will have not protocol, so add on https as needed.
                    queueItem.licenseUrl = queueItem.licenseUrl?.indexOf('https://') === 0?queueItem.licenseUrl:'https://' + queueItem.licenseUrl;

                    if (await validateLicenseURL(queueItem, license)) {
                        break;
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
}, 4);

const validateLicenseURL = async (queueItem: QueueItem, license: string) => {
    if (queueItem.licenseUrlIsValid !== null) {
        return queueItem.licenseUrlIsValid;
    }

    let licenseUrl = null;

    for (let i = 0; i < PrimaryBranchNames.length; i++) {
        const primaryBranch = PrimaryBranchNames[i];
        const urlToCheck =
            PrimaryBranchNames.find((b) => queueItem.repositoryURL!.includes(`/${b}/`)) !== undefined
                ? `${queueItem.repositoryURL}/${license}`
                // Gitlab and Github both use blob, whereas bitbucket uses src.
                : `${queueItem.repositoryURL}/${queueItem.repositoryURL?.includes('bitbucket.org')?'src':'blob'}/${primaryBranch}/${license}`;
        const urlExists = await ping(urlToCheck);
        log(queueItem, `Checking url: ${urlToCheck} Exists: ${urlExists}`);
        if (urlExists !== false) {
            licenseUrl = typeof urlExists === 'string' ? urlExists : urlToCheck;
            queueItem.licenseUrlIsValid = licenseUrl !== null;
            queueItem.licenseUrl = licenseUrl || license;
            return true;
        }
    }

    return false;
};

const ping = async (_url: string) => {
    return new Promise<boolean | string>((resolve, reject) => {
        const pathParts = safeURL(_url);
        const options:https.RequestOptions = {
            hostname: pathParts.hostname,
            port: pathParts.port,
            path: pathParts.pathname,
            method: 'HEAD',
        };

        const req = https.request(options, (res) => {
            switch (res.statusCode) {
                case 200:
                    resolve(true);
                    break;
                case 301:
                case 307:
                case 308:
                    resolve(res.headers.location !== undefined ? res.headers.location : true);
                    break;
                default:
                    resolve(false);
            }
        });

        req.on('error', (e) => {
            log(e);
            resolve(false);
        });

        req.end();
    });
};

processingQueue.drain(() => {
    progressBar.stop();

    fs.writeFile(
        outPath,
        result
            .sort((a, b) => {
                return a.name < b.name ? -1 : 1;
            })
            .map((q) => {
                if (q.package) {
                    return `${q.name} (${q.package.license})\n${[q.package.description, q.repositoryURL, q.licenseUrl].filter(l => l !== null && l !== undefined).join('\n')}`;
                } else {
                    return `${q.name} -> No package.json was found!`;
                }
            })
            .join('\n\n')
    );
    const successful = result.filter((q) => q.licenseUrlIsValid);
    const unsuccessful = result.filter((q) => !q.licenseUrlIsValid);

    const successfulCount = successful.length;
    const unsuccessfulCount = unsuccessful.length;
    const total = successfulCount + unsuccessfulCount;

    console.log(colors.bold(colors.green(`\nSaved to: ${outPath}`)));
    console.log(colors.green(`Processed ${total} packages.`));

    if (total !== successfulCount) {
        console.log(colors.yellow(`Found ${successfulCount} urls.`));
    } else {
        console.log(colors.green('Found licenses for all the packages.'));
    }

    if (unsuccessfulCount > 0) {
        console.log(colors.bold(colors.red(`Can\'t find ${unsuccessfulCount} license urls! Missing:`)));
        console.log('\t' + unsuccessful.map((l) => `${l.name}${l.missingLicenseReason ? formatMissingReason(l) : ''}`).join('\n\t'));
    }
});

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

const npmDepsToPaths = async (deep: boolean = false) => {
    const args = ['ls', '--prod', '--json', '--depth', deep?'Infinity':'0'];
    
    const deps = await npm(args);
    const result = JSON.parse(deps);
    const packagePaths: string[] = [];
    walkPath(result.dependencies, packagePaths);
    return packagePaths;
};

const npm = (args: string[]) => {
    return new Promise<string>((resolve, reject) => {
    const npm = spawn('npm', args, { cwd });
        const buffer: Buffer[] = [];
        npm.stdout.on('data', (data) => {
            buffer.push(data);
        });
        
        npm.on('close', () => {
            resolve(Buffer.concat(buffer).toString());
        });
    });
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const walkPath = (data: any, results: any[]) => {
    for (const key in data) {
        if (Object.prototype.hasOwnProperty.call(data, key)) {
            const module = data[key];
            if (results.find((p) => p === key) === undefined) {
                results.push(key);
            }

            if (module.dependencies) {
                walkPath(module.dependencies, results);
            }
        }
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

const noop = () => {};

export const run = async () => {
    const argv = await yargs(process.argv.slice(2)).options({
        deep: {type: 'boolean', default: false},
        verbose: {type: 'boolean', default: false},
        cwd: {type: 'string', default: process.cwd()}
    }).argv;
    
    const logDeep = argv.deep === true;

    verbose = argv.verbose === true;
    cwd = argv.cwd;
    outPath = path.join(cwd, 'installed-packages.txt');

    progressBar = verbose
        ? { start: noop, update: noop, stop: noop }
        : new cliProgress.SingleBar({ clearOnComplete: true }, cliProgress.Presets.shades_classic);

    if (!(await fs.pathExists(path.join(cwd, 'package.json')))) {
        console.log(colors.bold(colors.red('No package.json found! Exiting.')));
        return;
    }

    const deps:string[] = await npmDepsToPaths(logDeep);

    deps.forEach((item) => {
        const queueItem: QueueItem = {
            name: item,
            parent: path.join(cwd, 'node_modules', item),
            repositoryURL: null,
            licenseUrl: null,
            licenseUrlIsValid: null,
        };

        if (!(queueItem.name in packageHash)) {
            processingQueue.push(queueItem);
            packageHash[queueItem.name] = queueItem;
        }
    });

    console.log(colors.yellow(`Processing ${deps.length} packages.`));
    progressBar.start(deps.length, 0);
};

run();
