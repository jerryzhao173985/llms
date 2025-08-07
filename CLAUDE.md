# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## IMPORTANT: Repository Rules

**NEVER work on upstream repositories!**
- This is a FORK of musistudio/llms
- ONLY work on our fork: jerryzhao173985/llms
- NEVER push to upstream (musistudio/llms)
- NEVER create pull requests to upstream
- All work happens on our fork's main branch
- Upstream is configured as fetch-only (push disabled)

## Project Overview

This is a universal LLM API transformation server that acts as middleware to standardize requests and responses between different LLM providers (Anthropic, Gemini, Deepseek, etc.). It uses a modular transformer system to handle provider-specific API formats.

## Development Commands

### Build and Development
- **Install dependencies**: `npm install` or `pnpm install`
- **Development mode**: `npm run dev` (Uses nodemon + tsx for hot-reloading)
- **Build**: `npm run build` (Outputs dual CJS/ESM to dist/)
- **Build watch mode**: `npm run build:watch` (Continuous rebuild)
- **Lint**: `npm run lint` (ESLint on src directory)
- **Start server (CJS)**: `npm start` or `node dist/cjs/server.cjs`
- **Start server (ESM)**: `npm run start:esm` or `node dist/esm/server.mjs`

### Testing
Currently no test runner configured. Test files exist but need implementation.

## Architecture and Core Patterns

### Transformer Pattern
The core architectural pattern is a bidirectional transformer system where each provider implements:

```typescript
interface Transformer {
  transformRequestIn?: (request: UnifiedChatRequest, provider: LLMProvider) => Promise<Record<string, any>>;
  transformResponseIn?: (response: Response, context?: TransformerContext) => Promise<Response>;
  transformRequestOut?: (request: any) => Promise<UnifiedChatRequest>;
  transformResponseOut?: (response: Response) => Promise<Response>;
  endPoint?: string;
  auth?: (request: any, provider: LLMProvider) => Promise<any>;
}
```

### Request/Response Flow
1. **Ingestion**: Provider-specific request → `transformRequestOut` → UnifiedChatRequest
2. **Processing**: UnifiedChatRequest → `transformRequestIn` → Provider format
3. **API Call**: Send to LLM provider endpoint
4. **Response**: Provider response → `transformResponseOut` → Unified response
5. **Streaming**: Real-time chunk transformation for streaming responses

### Service Layer Architecture
- **ConfigService** (`src/services/config.ts`): Manages configuration from JSON5, .env, and environment variables
- **TransformerService** (`src/services/transformer.ts`): Registry and factory for all transformers
- **ProviderService** (`src/services/provider.ts`): Manages LLM provider configurations and routing
- **LLMService** (`src/services/llm.ts`): High-level abstraction for LLM operations

## Key Implementation Details

### Streaming Architecture
The Anthropic transformer (`src/transformer/anthropic.transformer.ts`) demonstrates sophisticated streaming handling:
- Converts between OpenAI and Anthropic streaming formats
- Manages thinking content, tool calls, and annotations
- Handles complex state during streaming (content blocks, indices)
- Processes web search result annotations

### Transformer Registration
Transformers are dynamically loaded and registered:
- Static transformers with `TransformerName` property
- Instance-based transformers with `name` property
- Automatic registration at server startup

### Build System
- **esbuild** for fast bundling
- Dual output: CommonJS (`dist/cjs/`) and ESM (`dist/esm/`)
- External dependencies: fastify, dotenv, @fastify/cors, undici
- Target: Node.js 18+
- Source maps and minification enabled

## Project Structure

- `src/server.ts`: Main entry point
- `src/transformer/`: Provider-specific transformer implementations
  - Each transformer handles bidirectional format conversion
  - Special transformers: maxtoken, sampling, tooluse, reasoning
- `src/services/`: Core services (config, llm, provider, transformer)
- `src/types/`: TypeScript type definitions
- `src/utils/`: Utility functions
- `src/api/`: API routes and middleware
- `scripts/build.ts`: esbuild configuration

## Path Aliases

- `@` is mapped to the `src` directory, use `import xxx from '@/xxx'`

## Adding New Transformers

1. Create a new transformer file in `src/transformer/`
2. Implement the Transformer interface methods
3. Export the transformer in `src/transformer/index.ts`
4. The transformer will be automatically registered at startup

## Configuration

Supports multiple configuration sources (in precedence order):
1. Environment variables
2. `.env` file
3. `config.json` or `config.json5`

## Related Project: Claude Code Router (CCR)

The `/Users/jerry/ccr` repository is a comprehensive routing system built on top of this library:
- **Purpose**: Routes Claude Code requests to different models with intelligent selection
- **Features**: Web UI, CLI management, GitHub Actions integration
- **Dependency**: Imports `@musistudio/llms` as core transformation engine
- **Commands**:
  - `ccr start|stop|restart|status` - Service management
  - `ccr ui` - Web interface
  - `ccr code "prompt"` - Execute Claude commands
  
CCR extends this server with additional endpoints (`/api/config`, `/api/transformers`, `/api/restart`) and provides the user experience layer.

## Technical Stack

- **Runtime**: Node.js 18+ with TypeScript
- **Framework**: Fastify for high-performance HTTP server
- **Build**: esbuild for dual CJS/ESM output
- **Dependencies**:
  - `@anthropic-ai/sdk`: Anthropic SDK
  - `@google/genai`: Google Generative AI SDK
  - `openai`: OpenAI SDK
  - `undici`: Modern HTTP client
  - `uuid`, `jsonrepair`: Utilities