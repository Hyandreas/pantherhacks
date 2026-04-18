# Repository Guidelines

# IF SOMETHING IS UNCLEAR, PROMPT THE USER FOR FURTHER CLARIFICATION
# IF SOMETHING IS NOT THE MOST DIRECT EFFICIENT LEAST OVERCOMPLICATED WAY, DONT DO IT

## Build, Test, and Development Commands

- `npm install` installs dependencies from `package-lock.json`.
- `npm run dev` starts the Vite development server.
- `npm run build` runs TypeScript project checks with `tsc -b` and creates a production build with Vite.
- `npm run preview` serves the production build locally for smoke testing.

No `npm test` script is configured. Use `npm run build` as the required verification step.

## Coding Style & Naming Conventions

Use TypeScript and React function components. Keep code strict-type compatible with the current `tsconfig.app.json` settings, including `strict`, `noUnusedLocals`, and `noUnusedParameters`.

Follow the existing style: two-space indentation, double quotes, semicolons, named helper functions, and PascalCase for React components and exported types. Use camelCase for variables, refs, and functions. Keep domain data typed through `src/types.ts`.

There is no formatter or linter configured beyond TypeScript, so match nearby code and keep edits focused.

## Commit & Pull Request Guidelines

The current history uses short summaries, for example `Added Brief` and `Initial commit: Lumen accessibility assistant hackathon demo`. Continue using concise messages that state the change clearly.

Pull requests should include a brief summary, verification steps, and screenshots or screen recordings for UI changes. Link related issues when available. Call out changes to privacy, microphone behavior, retention, or security headers.

## Security & Configuration Tips

Security headers are configured in `index.html` and `vite.config.ts`. Keep Content Security Policy, microphone permissions, and referrer behavior aligned. Do not add hidden persistence, telemetry, or network calls without clear user-facing consent.
