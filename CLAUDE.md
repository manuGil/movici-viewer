# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Movici Viewer is a web-based visualization platform for Movici geospatial simulations. 
It's a full-stack application with a Vue 3 frontend and FastAPI backend that visualizes simulation data stored on disk.

## Build & Development Commands

Development environment setup:

```bash
# activate Python virtual environment
source venv/bin/activate  # On Windows: venv\Scripts\activate
```

All commands run from the repository root via Makefile:

```bash
# First-time setup (installs all dependencies, builds client, sets up server)
make init

# Development: run both servers in separate terminals
make run-devel                          # Backend on port 5000 (uses tests/data by default)
make run-devel data_dir=/path/to/data   # Backend with custom data directory
make run-client                         # Frontend dev server on port 8080

# Client commands (from /client directory)
npm run build      # Production build
npm run lint       # ESLint with auto-fix
npm run format     # Prettier formatting
npm run type-check # TypeScript validation

# Server tests (from /server directory)
poetry run pytest tests/
poetry run pytest tests/test_scenarios.py          # Single test file
poetry run pytest tests/test_scenarios.py::test_fn # Single test function

# Production build
make build  # Builds UI and packages Python distribution
```

## Architecture

```
client/                     # Vue 3 + TypeScript + Vite frontend
├── src/
│   ├── api/               # API services (Local*Service classes)
│   ├── stores/            # Pinia state management
│   └── views/             # Vue components
├── movici-flow-lib/       # Git submodule with shared UI components

server/                     # Python FastAPI backend
├── movici_viewer/
│   ├── main.py            # FastAPI app factory & CLI entry
│   ├── routers/           # API endpoints (datasets, scenarios, updates, views)
│   ├── schemas/           # Pydantic response models
│   └── model/             # Repository pattern for data access
└── tests/
    └── data/              # Test simulation data
```

**Data Flow:** Frontend (Vue) → HTTP/axios → FastAPI routers → Repository → movici-simulation-core → File system

## Key Patterns

- **Backend dependency injection:** Repository instantiated via FastAPI's `Depends()`
- **Git submodule:** `client/movici-flow-lib` contains shared components (imported as `@movici-flow-lib`)
- **Environment variables:** Backend uses `MOVICI_FLOW_*` prefix (DATA_DIR, ALLOW_CORS, etc.)

## Simulations Directory Structure

The backend expects this layout:
```
simulations/
├── init_data/           # Initial datasets (*.json)
├── scenarios/
│   ├── scenario.json    # Scenario config
│   └── scenario/        # Updates: t<timestamp>_<iter>_<dataset>.json
└── views/               # User-created visualizations per scenario
```

## Code Style

- **Python:** Black formatter (line-length 99)
- **Client:** Prettier (printWidth 100), ESLint
- **Pre-commit hooks:** Run `pre-commit install` after setup

## UI Development Guidelines
- **Look at existing components** - Browse similar UI elements already implemented
- **Match existing patterns** - Try to maintain consistency with current designs
- **Use the component library** - Leverage Oruga-UI components and movici-flow-lib components
- **Follow Bulma conventions** - The project uses Bulma CSS framework

#### Key UI Technologies
- **Framework:** Vue 3 (Composition API)
- **Component Library:** Oruga-UI + Bulma theme
- **Custom Components:** movici-flow-lib
- **Styling:** SCSS/Sass
- **Visualization:** Deck.gl, Mapbox GL, Chart.js