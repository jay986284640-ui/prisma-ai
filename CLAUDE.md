# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

PrismaAI is an AI-powered job hunting copilot that helps users optimize projects, customize resumes, match jobs, and prepare for interviews. It includes modules for AI core processing, resume optimization, job matching, and learning preparation with Anki integration.

## Architecture

The project follows a monorepo structure with multiple packages:

- `packages/backend`: NestJS backend with MySQL, MongoDB, Redis, and MinIO integrations. Uses LangChain, LangGraph for AI processing.
- `packages/frontend`: React/Vue frontend application using Vite, Ant Design, TailwindCSS.
- `packages/agent-frontend`: Vue-based frontend for project highlight implementation agents.
- `packages/mcp-server`: Python-based server using FastMCP for AI communication protocols.
- `packages/shared`: Shared TypeScript utilities and types.
- `packages/magic-resume`: Next.js application for resume editing and PDF export.
- `packages/deepwiki-down`: Python service for deepwiki integration.

## Technology Stack

- Frontend: React, Vue, Vite, TypeScript, TailwindCSS, Ant Design
- Backend: NestJS, Next.js, FastAPI, TypeScript/Python
- Database: MySQL (Prisma ORM), MongoDB, Redis
- Storage: MinIO (object storage)
- AI/ML: LangChain, LangGraph, Transformers, OpenAI API, various LLM integrations
- DevOps: Docker, Docker Compose, PNPM workspaces

## Development Commands

### Setup
```bash
# Install dependencies
pnpm install

# Configure environment (follow doc/教程：1、环境配置.md)
```

### Running Applications

#### Full Development Mode
```bash
# Start all services concurrently
pnpm run dev
```

#### Individual Services
```bash
# Start backend only
pnpm run dev:b

# Start frontend only
pnpm run dev:f

# Start UI services (frontend, mcp-server, shared, agent-frontend)
pnpm run dev:ui

# Start shared services
pnpm run dev:s
```

### Building & Testing
```bash
# Format code
pnpm run format

# Lint code
pnpm run lint

# Run tests (specific to each package)
cd packages/backend && pnpm run test
cd packages/agent-frontend && pnpm run test:unit

# Build packages individually
cd packages/backend && pnpm run build
cd packages/frontend && pnpm run build
cd packages/magic-resume && pnpm run build
```

### Docker Deployment
```bash
# Quick start with Docker (uses pre-built images)
./scripts/start.sh

# Or use docker compose directly
docker compose -f compose.yaml up --build

# Development with hot reloading using Docker
docker compose -f compose.dev.yaml up --build
```

## Key Features & Workflows

1. **Project Highlight Implementation Agent**: Uses Plan-Executor architecture with CRAG (Corrective RAG) to help implement project highlights based on user codebase.
2. **Resume Optimization**: AI-powered resume improvement and PDF export functionality.
3. **Job Matching**: Real-time job scraping and vector-based matching to find suitable positions.
4. **Interview Preparation**: Question bank with Anki integration for effective learning.
5. **Knowledge Base Integration**: Supports DeepWiki for interactive, conversational documentation.
6. **Model Context Protocol (MCP)**: Python server enabling AI agents to interact with external systems through standardized tool calls for I/O operations.

## Data Management

The application requires several services:
- MySQL (port 3308) - Main application data
- MongoDB (port 27018) - Document storage
- Redis (port 6377) - Caching and queues
- MinIO (port 9003) - File storage
- Browserless Chrome - Web scraping capabilities

## Package-Specific Details

### Backend (`packages/backend`)
- Main API server with JWT authentication
- Prisma ORM for MySQL database management
- LangChain/LangGraph for AI orchestration
- Bull queue for background jobs
- Puppeteer for web scraping
- Supports multiple LLM providers: OpenAI, Google Gemini, Ollama, DeepSeek, Pinecone
- Includes transformers for local model processing
- Contains code analysis tools using tree-sitter parsers
- Uses MinIO for file storage
- Implements email services with Nodemailer

### Frontend (`packages/frontend`)
- Main application UI with React and TypeScript
- Qiankun micro-frontend integration
- Rich text editing with Milkdown editor
- Interactive mind maps with MarkMap
- Mermaid diagram rendering
- Integrated with CopilotKit for AI interactions
- Uses Ant Design and TailwindCSS for styling

### Agent Frontend (`packages/agent-frontend`)
- Vue-based interface for project highlight implementation agents
- Uses Element Plus UI components
- Vue Query for state management
- Pinia for state management
- Milkdown editor for rich text editing

### MCP Server (`packages/mcp-server`)
- Python server implementing Model Context Protocol
- FastAPI-based with various AI integrations
- Runs with uv Python package manager
- Provides asynchronous I/O capabilities for AI agents
- Allows agents to pause execution awaiting user input
- Exposes RESTful API for external client interaction
- Uses asyncio for concurrent operations

### Magic Resume (`packages/magic-resume`)
- Next.js application for resume editing and PDF export
- Tiptap editor for rich text editing
- Uses Radix UI components
- PDF generation capabilities using headless browsers
- Responsive design with Tailwind CSS

### DeepWiki Down (`packages/deepwiki-down`)
- Python service for converting DeepWiki sites to markdown
- Uses Playwright for browser automation
- Intercepts RSC (React Server Component) requests to extract markdown content directly
- Provides CLI interface for bulk downloading

### Shared (`packages/shared`)
- Shared TypeScript utilities and types across packages
- Reactive programming with RxJS

## Environment Configuration

Critical environment variables are located in:
- `packages/backend/.env` - Backend configuration
- `packages/backend/.env.production` - Production settings
- Models directory at `./models/` for local embeddings (moka-ai/m3e-base)

## Common Development Tasks

1. **Adding new AI provider support**: Modify backend LangChain integrations in `packages/backend/src/business/` or `packages/backend/src/agent/`
2. **Creating new API endpoints**: Add controllers to NestJS backend in `packages/backend/src/business/`
3. **Updating UI components**: Modify React/Vue components in frontend packages
4. **Extending resume editor**: Work in the magic-resume package
5. **Improving agent workflows**: Update LangGraph implementations in `packages/backend/src/agent/` or `packages/backend/src/business/prisma-agent/`
6. **Adding new MCP tools**: Extend the MCP server in `packages/mcp-server/src/mcp_server/` (server.py, api.py)
7. **Enhancing code parsing**: Extend tree-sitter parsers for additional languages

## Testing

Each package has its own testing setup:
- Backend: Jest for unit and e2e tests (`pnpm run test`, `pnpm run test:e2e`)
- Agent Frontend: Vitest for unit tests (`pnpm run test:unit`)
- Use the appropriate test commands in each package directory

## Model Setup

For local embedding models, run:
```bash
# Setup M3E model for local embeddings
./scripts/model_setup.sh
# Or use Docker to convert models to ONNX format
docker build -f scripts/Dockerfile.model-setup -t model-converter .
docker run -v $(pwd)/models:/models model-converter
```

## Docker Setup

The application uses a comprehensive Docker Compose setup that includes all required services. When developing locally, ensure you have MySQL, MongoDB, Redis, MinIO, and Chrome browser available either through Docker or local installations.

The compose.yaml includes:
- Browserless Chrome for web scraping
- Prisma AI backend service
- Magic Resume editor container
- Deepwiki downloader service
- Nginx as a reverse proxy
- MySQL, Redis, MongoDB, and MinIO as data stores

## AI Integration Architecture

The system uses multiple AI integration patterns:
- LangChain/LangGraph for complex AI workflows and orchestration
- Model Context Protocol (MCP) for external tool access
- Local embeddings using moka-ai/m3e-base models
- Multiple LLM provider support for flexibility
- CRAG (Corrective RAG) for enhanced retrieval accuracy
- Human-in-the-loop validation for AI outputs