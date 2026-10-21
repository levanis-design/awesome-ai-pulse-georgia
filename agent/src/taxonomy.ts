/**
 * What belongs in each category, in the words the blind placement review used
 * (when it ran on 2026-10-20, it agreed with the human placement on all but a
 * handful of repos). The model sees these when it picks a category; keep them
 * in step with the README intros.
 */
export const CATEGORY_RULES: Record<string, string> = {
  coding:
    "an agent or editor that itself writes or edits code: terminal coding agents, AI IDEs, autonomous SWE agents, AI code review and AI test agents, GitHub Actions that run a coding agent",
  orchestration:
    "running and managing many agents at once: agentic development environments for fleets of coding agents, terminal multiplexers for agents, agent teams on top of Claude Code/Codex/OpenCode, control panels, meta-harnesses",
  plugins:
    "general-purpose skills, plugin marketplaces and collections, subagent collections, workflow methodologies (spec-driven, TDD, task management for coding agents), behaviour files like CLAUDE.md, the skills format itself and skill tooling",
  codeintel:
    "gives an agent knowledge of a codebase or library docs: code knowledge graphs, semantic code search, up-to-date documentation context, generated codebase docs",
  tokens:
    "cutting or compressing token use, cost and usage tracking, gateways, routers, proxies and switchers that connect an agent to different models and providers",
  frameworks:
    "libraries, SDKs and languages developers use to build their own agents and multi-agent systems (building material, not finished apps)",
  mcp: "MCP and A2A protocols and their SDKs, generic MCP server collections, official connectors to SaaS services (GitHub, Notion, Supabase, Stripe, Sentry, Cloudflare, Google Workspace), tools that make arbitrary software usable by agents through a CLI",
  scraping:
    "web search and scraping APIs and their MCP servers, browser automation, headless browsers for agents, desktop and mobile computer-use agents",
  memory:
    "long-term agent memory, RAG engines, vector databases and search libraries, converting documents and files to Markdown for LLMs",
  agentinfra:
    "sandboxes and isolated runtimes for agents, environments to run agents at scale, evaluation frameworks, agent auditing, observability and tracing",
  security:
    "AI used for security work (pentest agents, security audits of code, reverse engineering, security skills) and security of AI itself (scanning skills for prompt injection)",
  infra:
    "engines that run or serve models locally or on servers, fine-tuning and training tools, open model weights, hardware-fit tools",
  workflow:
    "visual drag-and-drop platforms for AI workflows, agents and apps, durable workflow engines, and their ecosystems (an n8n MCP server, n8n skills)",
  assistants:
    "ready-made personal AI assistants (24/7 agents in WhatsApp, Telegram or Slack, the OpenClaw family) and ChatGPT-style chat apps for cloud or local models",
  business:
    "agents and tools for one kind of job: office documents and presentations, workspaces, CRM, marketing, HR and job search, product management, data and BI, email, meetings, commerce, AI coworkers",
  research:
    "deep-research agents, AI scientist, research and forecasting engines, NotebookLM alternatives, academic writing skills, AI tutors and classrooms",
  finance: "trading, financial analysis, financial data platforms and models",
  design:
    "UI components and design skills for agents, UI generation (screenshot or website to UI code), design systems and DESIGN.md, Figma integration, diagrams and whiteboards, 3D and CAD",
  media:
    "image and video generation models, UIs and pipelines, video editing, programmatic video, avatars and digital humans, combined video and audio generation",
  voice:
    "text-to-speech, voice cloning, voice studios, speech recognition (ASR), real-time voice-agent frameworks",
  resources:
    "courses, books, tutorials, cookbooks, guides, best-practice write-ups, awesome link lists, prompt and system-prompt collections",
};

export const PLACEMENT_RULE =
  "Function, not form: a repo goes where its job is, not where its packaging is. A video-making skill goes to media, a security skill to security, the n8n MCP server to workflow, a design MCP server to design, a voice-agent framework to voice, a web-search MCP server to scraping. plugins keeps only general-purpose skills and methodologies; mcp keeps protocols, generic MCP collections and SaaS connectors. A link list or learning material goes to resources whatever its topic, but a collection of installable files (skills, subagents, DESIGN.md files, rules) goes to the domain of those files.";
