# findl

Create a report of all your production licenses currently in-use.

## Why?

Sometimes companies requires you provide all your in-use licenses for a legal audit.

## Install

`yarn global add findl`
`npm i -g findl`

## Running

In your npm or dart based project.
`findl`

### Run with a GITHUB_TOKEN

GITHUB_TOKEN=your_token_from_here_<https://github.com/settings/tokens> findl

## Options

`--deep`
By default only the top level packages are found. If your audit requires you list everything in use, use `--deep` (Only for npm based projects, ignored for dart.)

`--cwd`
Default is `process.cwd()`

## Building

`yarn build`

## Dev'ing

`yarn dev`
