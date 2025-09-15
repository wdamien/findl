# Test Suite for findl

This directory contains comprehensive unit tests for the findl project using Vitest.

## Test Structure

- `setup.ts` - Global test setup and mocks
- `constants.test.ts` - Tests for constants and configuration values
- `types.test.ts` - Tests for TypeScript type definitions and interfaces
- `Utils.test.ts` - Tests for utility functions (URL parsing, git operations, etc.)
- `shared-utils.test.ts` - Tests for shared utility functions (license validation, GitHub API, etc.)
- `index.test.ts` - Tests for the main entry point and CLI functionality

## Running Tests

```bash
# Run all tests
yarn test

# Run tests once (no watch mode)
yarn test:run

# Run tests with UI
yarn test:ui

# Run tests with coverage
yarn test:coverage

# Run specific test file
yarn test:run tests/Utils.test.ts
```

## Test Coverage

The test suite covers:

### Core Utilities (`Utils.test.ts`)
- Git URL parsing and normalization
- HTTP request handling and status codes
- JSON parsing and error handling
- NPM dependency tree walking
- Async utilities (wait, timing)

### Shared Utilities (`shared-utils.test.ts`)
- URL validation and markdown formatting
- License name validation
- GitHub API integration for license detection
- License URL validation across different platforms
- File system operations (ignore files, project detection)
- Logging and error formatting

### Constants (`constants.test.ts`)
- Configuration values
- File name patterns
- License file detection patterns
- Git branch naming conventions

### Types (`types.test.ts`)
- TypeScript interface validation
- Enum value verification
- Function signature compliance

### Main Entry Point (`index.test.ts`)
- CLI argument parsing
- Project type detection
- Error handling for unsupported projects

## Mocking Strategy

The tests use comprehensive mocking to isolate units under test:

- External dependencies (fs-extra, octokit, etc.) are mocked
- Network requests are mocked with predictable responses
- File system operations are mocked to avoid side effects
- Console output is captured for assertion

## Test Isolation

Each test suite:
- Clears all mocks before each test
- Resets module state where applicable
- Uses fresh mock implementations
- Avoids shared state between tests

## Adding New Tests

When adding new functionality:

1. Create tests in the appropriate test file
2. Mock external dependencies
3. Test both success and error cases
4. Include edge cases and boundary conditions
5. Ensure tests are isolated and deterministic
