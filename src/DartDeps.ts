export type PubspecFileError = {
    error: {
        code: string;
        message: string;
    };
    code: string;
    message: string;
};

export type PubspecFile = {
    name: string;
    latest: Latest;
    versions: Latest[];
};

type Latest = {
    version: string;
    pubspec: Pubspec;
    archive_url: string;
    published: Date;
};

type Pubspec = {
    name: string;
    description: string;
    repository?: string;
    issue_tracker?: string;
    version: string;
    homepage?: string;
    environment: Environment;
    dependencies: Dependencies;
    dev_dependencies: DevDependencies;
    flutter: null;
};

type Dependencies = {
    flutter: Flutter;
};

type Flutter = {
    sdk: SDK;
};

enum SDK {
    Flutter = 'flutter',
}

type DevDependencies = {
    flutter_test: Flutter;
};
type Environment = {
    sdk: string;
    flutter: string;
};