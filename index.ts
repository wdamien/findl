import async from 'async';
import * as cliProgress from 'cli-progress';
import colors from 'colors/safe';
import * as fs from 'fs-extra';
import * as path from 'path';
import yargs from 'yargs';
import { Octokit } from '@octokit/rest';
import { createTokenAuth } from '@octokit/auth-token';
import {
    QueueItem,
    DependencyType,
    ProjectType,
    ProgressBar,
} from './src/types';
import {
    setVerbose,
    setCwd,
    setOctokit,
    setUseGithubAPI,
    wrapInMarkdownUrl,
    formatMissingReason,
    loadIgnoreFile,
    findProjectType,
} from './src/shared-utils';
import {
    processNPMQueue,
    getNPMdeps,
    getYarnBerryDeps,
    setNodeProcessorCwd,
    setNodeProgressBar,
    setNodeResult,
} from './src/node-processor';
import {
    processPubspecQueue,
    getDartDeps,
    setDartProcessorCwd,
    setDartProgressBar,
    setDartResult,
} from './src/dart-processor';
import { noop } from './src/Utils';

const result: QueueItem[] = [];

let verbose = false;
let progressBar: ProgressBar;
let cwd: string = process.cwd();
let outPath: string;
let octokit: Octokit;
let useGithubAPI: boolean;

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

    // Set up shared utilities
    setVerbose(verbose);
    setCwd(cwd);
    setNodeProcessorCwd(cwd);
    setDartProcessorCwd(cwd);
    setNodeResult(result);
    setDartResult(result);

    const supportedTypes: ProjectType[] = [
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

    const projectType = await findProjectType(supportedTypes);

    if (projectType === null) {
        console.log(
            colors.bold(
                colors.red('No supported dependencies file found. Exiting.'),
            ),
        );
        return;
    }

    console.log(
        colors.bold(colors.green(`Found a ${projectType.type} project.`)),
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
            colors.bold(
                colors.yellow('*** Invalid GITHUB_TOKEN.  Ignoring...'),
            ),
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
                `You have ${remaining} Github api requests left. They'll reset to ${limit} at ${refreshDate.toLocaleDateString()} ${refreshDate.toLocaleTimeString()}`,
            ),
        );

        if (!GITHUB_TOKEN) {
            console.log(
                colors.white(
                    "Hint: If you set a GITHUB_TOKEN env. You'll get more requests (and more accurate results).",
                ),
            );
        }
    } else {
        useGithubAPI = false;
        console.log(colors.red('Error connecting to the GitHub api.'));
    }

    // Set up octokit and progress bar for processors
    setOctokit(octokit);
    setUseGithubAPI(useGithubAPI);

    progressBar = verbose
        ? { start: noop, update: noop, stop: noop }
        : new cliProgress.SingleBar(
              { clearOnComplete: true },
              cliProgress.Presets.shades_classic,
          );

    setNodeProgressBar(progressBar);
    setDartProgressBar(progressBar);

    const processingQueue: async.QueueObject<QueueItem> = async.queue(
        projectType.processor,
        4,
    );
    processingQueue.drain(() => {
        progressBar.stop();

        // Note the 2 spaces before each newline, its to prevent GitHub from removing them in their preview.
        // Details: https://stackoverflow.com/a/51125093
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
                    }${!hasBrackets ? ')' : ''}**  \n\n${[
                        q.description,
                        wrapInMarkdownUrl(q.repositoryURL),
                        wrapInMarkdownUrl(q.licenseUrl),
                    ]
                        .filter(
                            (l) => l !== null && l !== undefined && l !== '',
                        )
                        .join('  \n')}`;
                })
                .join('  \n\n'),
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
                    colors.red(`Can\'t find ${unsuccessfulCount} licenses!`),
                ),
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
                            }\n\t\tlicense url: ${l.licenseUrl}`,
                    )
                    .join('\n\t');
            console.log(missingPackages);
        }
    });

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

    if (ignored.length > 0) {
        console.log(
            colors.yellow(
                `Ignoring ${ignored.length} packages:\n\t${ignored
                    .sort()
                    .join('\n\t')}`,
            ),
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

run();
