# Security Policy

## Supported versions

Security fixes are applied to the default branch (`main`) unless otherwise noted.

## Reporting a vulnerability

Please **do not** open a public issue for undisclosed vulnerabilities.

Instead, email **[REPLACE_WITH_SECURITY_EMAIL]** with:

- Short description of the issue and impact
- Steps to reproduce (or proof-of-concept where safe)
- Affected versions or commit SHA if known

Expected response time: we will acknowledge within a few business days where possible.

## Sensitive files

Never commit:

- `.env`, `.env.local`, or real values in `.env.example`
- Google service account JSON (`config/gcp-service-account.json`)
- Private keys, `.pem`, or similar (see `.gitignore`)

## Historical note

Older commits at one point contained a placeholder-style Freshrelease token in tracked example/MCP config files. **Treat that token as compromised if it was ever real** — rotate it in your Freshrelease account and use only `.env` locally. New contributors should always use their own secrets in `.env`.
