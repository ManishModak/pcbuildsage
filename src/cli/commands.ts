export type CommandContext = "interactive" | "subcommand" | "both";

export type CommandDefinition = {
  name: string;
  slash: string;
  subcommand: string;
  usage: string;
  summary: string;
  context: CommandContext;
};

const DEFINITIONS: CommandDefinition[] = [
  { name: "ask", slash: "/ask", subcommand: "ask", usage: 'ask "<query>" [--json]', summary: "Ask one question and exit.", context: "both" },
  { name: "scrape", slash: "/scrape", subcommand: "scrape", usage: "scrape --profile india [--categories gpu,cpu] [--quick]", summary: "Run the Python scraper with terminal progress.", context: "both" },
  { name: "provider", slash: "/provider", subcommand: "provider", usage: "provider [provider:model]", summary: "Show or switch the primary LLM provider entry.", context: "both" },
  { name: "models", slash: "/models", subcommand: "models", usage: "models --provider gemini [--base-url url]", summary: "List models for a provider.", context: "both" },
  { name: "personality", slash: "/personality", subcommand: "personality", usage: "personality [id]", summary: "Show or switch the chat personality.", context: "both" },
  { name: "audit", slash: "/audit", subcommand: "audit", usage: "audit on|off", summary: "Toggle Tier 2 advisory audit.", context: "both" },
  { name: "search", slash: "/search", subcommand: "search", usage: "search [provider|off]", summary: "Show or switch the grounding search provider.", context: "both" },
  { name: "export-research", slash: "/export-research", subcommand: "export-research", usage: "export-research [--output-dir path]", summary: "Export registry research as PR-ready JSON.", context: "both" },
  { name: "theme", slash: "/theme", subcommand: "theme", usage: "theme [id]", summary: "Show or switch the terminal theme.", context: "both" },
  { name: "test-profile", slash: "/test-profile", subcommand: "test-profile", usage: "test-profile <file> [--site name]", summary: "Run scraper selector checks without DB writes.", context: "both" },
  { name: "validate", slash: "/validate", subcommand: "validate", usage: "validate --parts build.json [--json]", summary: "Run deterministic Tier 1 validation.", context: "both" },
  { name: "config", slash: "/config", subcommand: "config", usage: "config get|set <key> [value]", summary: "Manage .pcbuildsage/config.json.", context: "both" },
  { name: "help", slash: "/help", subcommand: "help", usage: "help", summary: "List commands.", context: "both" },
  { name: "exit", slash: "/exit", subcommand: "exit", usage: "exit", summary: "Exit the REPL.", context: "interactive" }
];

export function commandRegistry(): CommandDefinition[] {
  return [...DEFINITIONS];
}

export function findCommand(input: string): CommandDefinition | undefined {
  const [first] = input.trim().split(/\s+/);
  return DEFINITIONS.find((command) => command.slash === first || command.subcommand === first || command.name === first);
}

export function slashCommands(): CommandDefinition[] {
  return DEFINITIONS.filter((command) => command.context === "interactive" || command.context === "both");
}

export function subcommands(): CommandDefinition[] {
  return DEFINITIONS.filter((command) => command.context === "subcommand" || command.context === "both");
}

export function helpText(context: CommandContext = "both"): string {
  const commands = context === "interactive" ? slashCommands() : context === "subcommand" ? subcommands() : DEFINITIONS;
  const usages = commands.map((command) => context === "interactive" ? command.usage.replace(command.subcommand, command.slash) : command.usage);
  const width = Math.max(...usages.map((usage) => usage.length));
  return commands.map((command, index) => `${usages[index].padEnd(width)}  ${command.summary}`).join("\n");
}
