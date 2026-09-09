# Web Search Skill

Real-time web search capability for GenWork using Playwright-controlled browser automation.

## Overview

The Web Search Skill enables GenWork to perform live web searches using Google and Bing, with automatic fallback when one provider is unavailable. The skill uses Playwright to control a local Chrome browser instance, making all operations transparent and observable.

## Features

- **Real-time Search** - Access current web information via Google with Bing fallback
- **Transparent Operations** - Visible browser window shows all actions
- **Playwright-Powered** - Robust browser automation using playwright-core
- **Simple CLI** - Easy-to-use command-line interface
- **HTTP API** - RESTful bridge server for advanced integrations
- **Auto-Managed** - Electron starts and stops the bridge server automatically
- **Connection Caching** - Reuses browser connections for performance
- **Localhost Only** - Secure by design, no external exposure

## Architecture

```
GenWork (renderer) → Bridge Server (localhost:8923) → Playwright → CDP → Chrome
```

**Components:**

1. **Bridge Server** - Express HTTP API for browser control
2. **Playwright Manager** - Connection and session management
3. **Browser Launcher** - Chrome lifecycle management
4. **Search Engines** - Google primary and Bing fallback
5. **CLI Scripts** - Simplified command-line interface
6. **Electron Integration** - Automatic service management

## Quick Start

### 1. Install Dependencies

```bash
cd SKILLs/web-search
npm install
```

### 2. Build

```bash
npm run build
```

### 3. Start Server

```bash
bash scripts/start-server.sh
```

### 4. Perform Search

```bash
bash scripts/search.sh "TypeScript tutorial" 5
```

### 5. Stop Server

```bash
bash scripts/stop-server.sh
```

## Usage

### Simple Search

```bash
bash SKILLs/web-search/scripts/search.sh "search query" [max_results]
```

**Examples:**

```bash
# Search for React 19 features (default 10 results)
bash scripts/search.sh "React 19 new features"

# Search for TypeScript tutorials (limit to 5 results)
bash scripts/search.sh "TypeScript tutorial" 5

# Search for current news
bash scripts/search.sh "AI news 2026" 10
```

### API Usage

See [examples/basic-search.md](examples/basic-search.md) for complete API documentation.

**Health Check:**

```bash
curl http://127.0.0.1:8923/api/health
```

**Search:**

```bash
curl -X POST http://127.0.0.1:8923/api/search \
  -H "Content-Type: application/json" \
  -d '{"connectionId": "...", "query": "...", "maxResults": 5}'
```

## Configuration

Default configuration in `server/config.ts`:

```typescript
{
  browser: {
    cdpPort: 9222,
    headless: false,  // Always visible
    chromeFlags: [/* ... */]
  },
  server: {
    port: 8923,
    host: '127.0.0.1'  // Localhost only
  },
  search: {
    defaultEngine: 'auto',
    fallbackOrder: ['google', 'bing'],
    defaultMaxResults: 10,
    searchTimeout: 30000,
    navigationTimeout: 15000
  }
}
```

## How GenWork Uses This Skill

When GenWork needs real-time information, it will:

1. **Recognize the need** - Questions about current events, latest docs, etc.
2. **Check server** - Verify the bridge server is running
3. **Execute search** - Run `bash scripts/search.sh "query" N`
4. **Parse results** - Extract relevant information from the Markdown output
5. **Answer user** - Provide a response based on search results

**Example Interaction:**

```
User: What are the new features in Next.js 14?

GenWork: [Calls: bash SKILLs/web-search/scripts/search.sh "Next.js 14 features" 5]

        Based on the latest search results, Next.js 14 introduces:
        1. Turbopack - 5000x faster than Webpack
        2. Server Actions (stable) - Simplified data mutations
        3. Partial Prerendering - Faster page loads
        ...
```

## API Endpoints

### Browser Management

- `POST /api/browser/launch` - Launch Chrome
- `POST /api/browser/connect` - Connect to browser
- `POST /api/browser/disconnect` - Disconnect
- `GET /api/browser/status` - Get status

### Search Operations

- `POST /api/search` - Execute search
- `POST /api/search/content` - Get URL content

### Page Operations

- `POST /api/page/navigate` - Navigate to URL
- `POST /api/page/screenshot` - Take screenshot
- `POST /api/page/content` - Get HTML content
- `POST /api/page/text` - Get text content

### Utility

- `GET /api/health` - Health check
- `GET /api/connections` - List connections

## Project Structure

```
SKILLs/web-search/
├── README.md                    # This file
├── SKILL.md                     # Skill documentation (for GenWork)
├── LICENSE.txt                  # MIT License
├── package.json                 # Dependencies
├── tsconfig.json                # TypeScript config
├── server/                      # Bridge server source
│   ├── index.ts                 # Express server
│   ├── config.ts                # Configuration
│   ├── playwright/
│   │   ├── manager.ts           # Playwright connection manager
│   │   ├── browser.ts           # Browser lifecycle
│   │   └── operations.ts        # Page operations
│   └── search/
│       ├── types.ts             # Type definitions
│       ├── google.ts            # Google search engine
│       └── bing.ts              # Bing fallback engine
├── scripts/                     # CLI tools
│   ├── start-server.sh          # Start bridge server
│   ├── stop-server.sh           # Stop bridge server
│   ├── search.sh                # Search CLI
│   ├── test-basic.js            # Basic functionality test
│   └── test-search.js           # Integration test
├── examples/                    # Usage examples
│   └── basic-search.md          # Complete usage guide
└── dist/                        # Compiled output (auto-generated)
```

## Testing

### Basic Functionality Test

```bash
node scripts/test-basic.js
```

Tests:

- Browser launch and connection
- Playwright connection management
- Page navigation
- Title and content extraction
- Screenshot capture
- Resource cleanup

### Search Integration Test

```bash
node scripts/test-search.js
```

Tests:

- Bridge server startup
- Browser launch via API
- Playwright connection
- Bing search execution
- Result parsing
- Screenshot and text extraction
- Full cleanup

## Troubleshooting

### Server Won't Start

```bash
# Check logs
cat .server.log

# Check if port is in use
lsof -i :8923

# Rebuild
npm run build
```

### Chrome Not Found

Install Chrome:

- macOS: https://www.google.com/chrome/
- Linux: `sudo apt install chromium-browser`
- Windows: https://www.google.com/chrome/

### Connection Issues

```bash
# Clean up
bash scripts/stop-server.sh
rm .connection .server.pid

# Restart
bash scripts/start-server.sh
```

## Security

- **Localhost only** - Server binds to 127.0.0.1
- **No external access** - Not exposed to network
- **Isolated profile** - Separate Chrome user-data-dir
- **Visible operations** - All actions shown in browser window
- **No credentials** - No sensitive operations performed

## Requirements

- Node.js 18+
- Google Chrome or Chromium
- macOS, Windows, or Linux
- Internet connection for searches

## Dependencies

- `express` - HTTP server
- `playwright-core` - Browser automation
- `uuid` - Connection ID generation

## License

MIT License - See [LICENSE.txt](LICENSE.txt).

## Contributing

This skill ships with GenWork. For issues or suggestions:

1. Check existing issues
2. Create detailed bug reports
3. Include logs from `.server.log`
4. Test with the latest version
