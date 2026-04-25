# Repository Guidelines

## Project Structure & Module Organization

This repository is a lightweight single-process WebUI for GPT/NewAPI image generation.

- `app.py` contains the Python HTTP server, authentication, settings, task execution, upstream image API calls, gallery persistence, and static file serving.
- `static/index.html` defines the single-page UI structure.
- `static/app.js` contains all browser-side state, API calls, gallery rendering, task polling, mask painting, dialogs, and mobile navigation.
- `static/styles.css` contains responsive layout and component styling.
- `data/` is runtime-generated and ignored by git. It stores `config.json`, `db.json`, and generated/source images under `data/images/`.
- `requirements.txt` lists Python dependencies.

There is currently no formal test directory.

## Build, Test, and Development Commands

Install dependencies:

```powershell
python -m pip install -r requirements.txt
```

Run locally:

```powershell
python app.py
```

Default URL:

```text
http://127.0.0.1:7860
```

Syntax-check the backend:

```powershell
python -m py_compile app.py
```

Syntax-check frontend JavaScript:

```powershell
node --check static/app.js
```

## Coding Style & Naming Conventions

Use 4-space indentation for Python and 2-space indentation for HTML, CSS, and JavaScript. Keep the project dependency-light; prefer the Python standard library unless a dependency clearly improves reliability.

Python functions use `snake_case`, constants use `UPPER_SNAKE_CASE`, and frontend functions/variables use `camelCase`. Keep UI element IDs descriptive, for example `maskPainterDialog`, `galleryGrid`, and `expectedTaskSecondsInput`.

Avoid broad rewrites. This project is intentionally simple: one backend module and static frontend assets.

## Testing Guidelines

No automated test framework is configured yet. For changes, run both syntax checks:

```powershell
python -m py_compile app.py
node --check static/app.js
```

For backend behavior, prefer small local self-checks with mocked upstream responses instead of calling real image APIs. For UI changes, manually verify workbench generation flow, task polling, gallery actions, prompt editing, mask painting, and mobile navigation.

## Commit & Pull Request Guidelines

This directory is not currently a git repository, so no commit history conventions are available. Use concise imperative commit messages if git is initialized later, for example:

```text
Add task progress settings
Fix gallery masonry layout
```

Pull requests should include a short summary, verification commands run, screenshots or screen recordings for UI changes, and notes about any config or data migration impact.

## Security & Configuration Tips

Do not commit `data/`, API keys, generated images, or local passwords. WebUI passwords and API keys are stored in `data/config.json`, which is intentionally git-ignored. If an API key is exposed in chat, logs, or commits, rotate it immediately.
