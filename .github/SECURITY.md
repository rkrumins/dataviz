# Security Policy

## Reporting a vulnerability

Please report security vulnerabilities privately rather than opening a public issue.

Use GitHub's **private vulnerability reporting**: go to the
[Security tab](https://github.com/rkrumins/dataviz/security) → **Report a vulnerability**.
This opens a private advisory visible only to the maintainers.

Please include:

- A description of the vulnerability and its impact
- Steps to reproduce (proof of concept if possible)
- Affected component(s) and version/commit

## What to expect

- We aim to acknowledge new reports within a few business days.
- We will keep you informed as we investigate and work on a fix.
- Once a fix is released, we will credit you in the advisory unless you prefer otherwise.

## Automated scanning

This repository continuously scans for vulnerabilities using GitHub's built-in tooling:

- **Dependabot** — dependency alerts, automated security-update PRs, and scheduled version updates
- **CodeQL** — static analysis for code-level vulnerabilities
- **Dependency review** — blocks pull requests that introduce known-vulnerable dependencies
- **Secret scanning** — detects committed credentials and blocks new ones via push protection
