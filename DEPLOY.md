# Deploying AutoReg

Pushing to `main` on GitHub runs the test suite, then — only if it's green — publishes to Cloudflare Pages. This is a one-time setup; every push after this is automatic.

## 1. Push this repo to GitHub

```bash
git init
git add .
git commit -m "AutoReg"
git branch -M main
git remote add origin https://github.com/<you>/<repo>.git
git push -u origin main
```

The first push will run the `test` job (in **Actions** on GitHub) but the `deploy` job will fail until the secrets below are in place — that's expected.

## 2. Create a Cloudflare API token

1. Cloudflare dashboard → your profile icon (top right) → **API Tokens** → **Create Token**.
2. **Custom token** → **Get started**.
3. Under **Permissions**, add: **Account** → **Cloudflare Pages** → **Edit**.
4. Scope it to your account under **Account Resources**.
5. Create the token and copy it — Cloudflare only shows it once.

## 3. Find your Cloudflare Account ID

Dashboard → **Workers & Pages** → the Account ID is in the right-hand sidebar on the Overview page.

## 4. Add both as GitHub repo secrets

In your GitHub repo: **Settings** → **Secrets and variables** → **Actions** → **New repository secret**.

| Name | Value |
|---|---|
| `CLOUDFLARE_API_TOKEN` | the token from step 2 |
| `CLOUDFLARE_ACCOUNT_ID` | the account ID from step 3 |

## 5. Push to main

```bash
git commit --allow-empty -m "Trigger deploy"
git push
```

Watch it run under the **Actions** tab. First deploy creates the `autoreg` Cloudflare Pages project automatically (named from `--project-name=autoreg` in the workflow); it'll be live at `https://autoreg.pages.dev`. If you'd rather control the project name or production branch yourself, create the project first with `npx wrangler pages project create autoreg`, or via **Workers & Pages** → **Create application** in the dashboard — the workflow will deploy into whatever already exists under that name.

## What runs on every push

- **Every push and pull request**: `npm test` (101 unit tests) and `node tests/app.smoke.js` (end-to-end scenarios against the real app code).
- **Push to `main` only, after tests pass**: copies the deployable files (`index.html`, `styles.css`, `app.js`, `autoreg-math.js`, `autoreg-migrations.js`, `manifest.json`, `sw.js`, `icons/`) into `dist/` and publishes it with Wrangler.

Nothing else in the repo (`tests/`, `package.json`, `ARCHITECTURE-CHANGES.md`) gets deployed — see `.github/workflows/deploy.yml`.

## Changing the project name or domain

- **Project name**: edit `--project-name=autoreg` in `.github/workflows/deploy.yml`.
- **Custom domain**: Cloudflare dashboard → your Pages project → **Custom domains** → **Set up a domain**. No workflow change needed.
