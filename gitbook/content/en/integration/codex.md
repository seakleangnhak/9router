# OpenAI Codex CLI Integration

Integrate 9Router with OpenAI Codex CLI to route your OpenAI API requests through 9Router's intelligent routing system.

## Prerequisites

- OpenAI Codex CLI installed
- 9Router running locally or cloud endpoint configured
- API key from 9Router dashboard

## Setup

### 1. Configure Environment Variables

Set the following environment variables in your shell configuration file (`~/.bashrc`, `~/.zshrc`, or `~/.bash_profile`):

```bash
# Base URL for 9Router
export OPENAI_BASE_URL="http://localhost:20128/v1"

# API Key from 9Router dashboard
export OPENAI_API_KEY="your-9router-api-key"
```

### 2. Reload Shell Configuration

```bash
source ~/.zshrc  # or ~/.bashrc
```

### 3. Verify Configuration

Check that the environment variables are set correctly:

```bash
echo $OPENAI_BASE_URL
echo $OPENAI_API_KEY
```

## Available Models

9Router provides the following Codex models:

| Model ID | Description |
|----------|-------------|
| `cx/gpt-5.2-codex` | GPT-5.2 Codex - Latest version |
| `cx/gpt-5.1-codex-max` | GPT-5.1 Codex Max - Extended context |

## Usage Examples

### Basic Usage

```bash
# Use GPT-5.2 Codex
codex --model cx/gpt-5.2-codex "Write a function to sort an array"

# Use GPT-5.1 Codex Max
codex --model cx/gpt-5.1-codex-max "Explain this complex algorithm"
```

### Code Generation

```bash
codex --model cx/gpt-5.2-codex "Create a REST API endpoint for user authentication"
```

### Code Explanation

```bash
codex --model cx/gpt-5.1-codex-max "Explain what this code does: $(cat myfile.js)"
```

## Configuration File

You can also configure Codex CLI using a configuration file. Create or edit `~/.codex/config.json`:

```json
{
  "baseUrl": "http://localhost:20128/v1",
  "apiKey": "your-9router-api-key",
  "defaultModel": "cx/gpt-5.2-codex"
}
```

## Troubleshooting

### Fast mode (priority service tier)

In **Endpoint → API Keys**, click the lightning control to cycle **OFF → ON → FORCE**:

- **OFF** forces `service_tier: "default"`, even when the client requests Fast mode.
- **ON** follows the client's requested tier.
- **FORCE** sets `service_tier: "priority"`, even when the client requests normal speed.

New keys default to OFF. Existing enabled keys become ON; disabled keys become OFF.
The policy also applies to aliases, combos, and other priority-tier chat providers.
Missing, inactive, or unknown keys use OFF when **Require API key** is disabled;
when enabled, those keys receive the usual `401` authentication error.

Administrators can set the mode with `PUT /api/keys/{id}` and
`{"fastMode": "off"}`, `{"fastMode": "on"}`, or `{"fastMode": "force"}`.
Legacy `allowFastMode: true` maps to ON and `false` maps to OFF.

9Router forwards `service_tier: "priority"` to the Codex backend and also accepts
`"fast"` as an alias. This works with `/v1/responses` and `/v1/chat/completions`,
including GPT-6.1 Sol. With the key set to ON, omit the field or send `"default"` for Standard mode.
Fast mode keeps the selected reasoning effort.

```json
{
  "model": "cx/gpt-6.1-sol",
  "input": "Explain this function",
  "service_tier": "priority",
  "reasoning": { "effort": "high" }
}
```

For the Codex CLI `/fast` toggle, the model ID must match a model in the CLI's
catalog that advertises Fast mode. A prefixed ID such as `cx/gpt-6.1-sol` can be
treated as an unknown model, causing the CLI to hide `/fast` and omit the tier.
Create a model alias in the 9Router dashboard mapping `gpt-6.1-sol` to
`cx/gpt-6.1-sol`, then use the bare ID in `~/.codex/config.toml`:

```toml
model = "gpt-6.1-sol"
model_provider = "9router"
service_tier = "fast"

[features]
fast_mode = true

[model_providers.9router]
name = "9Router"
base_url = "http://localhost:20128/v1"
wire_api = "responses"

[model_providers.9router.http_headers]
Authorization = "Bearer your-9router-api-key"
```

Merge these settings with the existing TOML tables. Use a current Codex CLI with
GPT-6.1 Sol in its catalog. `/fast` toggles Fast mode; `/statusline` can show its
status. The underlying ChatGPT account and model must have Fast mode access;
9Router does not grant access or guarantee latency. Fast mode uses more quota.
See [official OpenAI documentation](https://developers.openai.com/codex/speed).

### Authentication Errors

If you encounter authentication errors:

1. Verify your API key is correct in 9Router dashboard
2. Check that `OPENAI_API_KEY` environment variable is set
3. Ensure the API key has not expired

### Connection Issues

If you encounter connection errors:

1. Verify 9Router is running: `curl http://localhost:20128/health`
2. Check environment variables are set correctly
3. Ensure no firewall is blocking port 20128

### Model Not Available

If you get "model not available" errors:

1. Verify the model name matches your 9Router configuration
2. Check that the OpenAI provider connection is active in 9Router dashboard
3. Ensure the model is available in your connected providers

## Cloud Endpoint

To use 9Router cloud endpoint instead of localhost:

```bash
export OPENAI_BASE_URL="https://9router.com"
```

Make sure you have configured your API key in the 9Router cloud dashboard.

## Advanced Configuration

### Custom Timeout

```bash
export OPENAI_TIMEOUT=60  # seconds
```

### Debug Mode

Enable debug mode to see detailed request/response logs:

```bash
export CODEX_DEBUG=true
codex --model cx/gpt-5.2-codex "Your prompt"
```
