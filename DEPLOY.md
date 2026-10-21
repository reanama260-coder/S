# Deploy Stremio Hentai Hub v2.5.5

The project files are at the ZIP root. When adding this project to GitHub, upload these files directly into the repository root; do not keep them one directory deeper.

## Node hosting

- Use Node.js 20 or newer.
- Install command: `npm install`
- Start command: `npm start`
- The app listens on the port supplied in `PORT` (defaults to 3000).
- After deployment, test `/manifest.json`. Install the public HTTPS URL ending in `/manifest.json` in Stremio.

This ZIP does not contain a generated package-lock.json because the build environment cannot reach the npm registry. Use `npm install`, not `npm ci`, until a lockfile has been generated on a networked machine.
