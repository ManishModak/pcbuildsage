# Security Policy

## Reporting a vulnerability

Please **don't** open a public issue for security problems. Report them privately through GitHub: go to the repository's **Security** tab and choose **Report a vulnerability**. Only the maintainers can see the report.

Include what you found, how to reproduce it, and what an attacker could do with it. You'll get a reply as soon as a maintainer can look at it; PCBuildSage is a volunteer project, so please allow a few days.

## What's in scope

- **Local mode:** anything that lets another website, another device on the network, or a crafted page reach the local API, read chats or logs, start scrapes, or obtain the API keys in `.env`.
- **Hosted demo:** anything that exposes a visitor's API key or chats, makes the server use its own keys or resources for visitors, or reaches internal network addresses.
- **Scraper and research tools:** fetching local files or internal addresses, or instructions in crawled pages taking over the assistant.

Wrong prices or wrong compatibility verdicts are bugs, not security issues: please use a normal issue for those.

## Supported versions

Only the latest `master` is supported. Fixes are not backported.
