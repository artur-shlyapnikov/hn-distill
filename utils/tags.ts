export type CanonTag = { name: string; cat?: string | undefined };

const ALIASES: Record<string, string> = {
  js: "javascript",
  node: "nodejs",
  "open ai": "openai",
  llms: "llm",
  k8s: "kubernetes",
  postgres: "postgresql",
  psql: "postgresql",
  react: "reactjs",
  vue: "vuejs",
  tf: "tensorflow",
  ai: "llm",
  ml: "machine-learning",
  gpt: "llm",
  chatgpt: "llm",
  "web assembly": "webassembly",
  /* expand incrementally */
};

export function slugify(s: string): string {
  return s
    .trim()
    .toLowerCase()
    .replaceAll(/['’]/gu, "") // drop quotes
    .replaceAll(/[^\d#+\-.a-z]+/gu, "-") // keep techy symbols minimally
    .replaceAll(/-+/gu, "-")
    .replaceAll(/^-|-$/gu, "");
}

export function canonicalize(t: CanonTag): { slug: string; cat?: string | undefined } {
  const base = ALIASES[t.name.toLowerCase()] ?? t.name;
  return { slug: slugify(base), cat: t.cat };
}

export function dedupeKeepOrder(tags: Array<{ slug: string; cat?: string }>): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const t of tags) {
    if (!seen.has(t.slug)) {
      seen.add(t.slug);
      out.push(t.slug);
    }
  }
  return out;
}

function extractDomainTags(domain: string | undefined): string[] {
  // Explicitly handle undefined and empty/whitespace-only strings
  if (domain === undefined || domain.trim() === "") {
    return [];
  }

  const d = domain.toLowerCase();
  const domainTags: string[] = [];

  if (d.includes("github.com")) {
    domainTags.push("github");
  }
  if (d.includes("arxiv.org")) {
    domainTags.push("arxiv");
  }
  if (d.includes("medium.com")) {
    domainTags.push("medium");
  }
  if (d.includes("stackoverflow.com")) {
    domainTags.push("stackoverflow");
  }
  if (d.includes("youtube.com") || d.includes("youtu.be")) {
    domainTags.push("youtube");
  }
  if (d.includes("twitter.com") || d.includes("x.com")) {
    domainTags.push("twitter");
  }
  if (d.includes("reddit.com")) {
    domainTags.push("reddit");
  }
  if (d.includes("aws.amazon.com")) {
    domainTags.push("aws");
  }
  if (d.includes("cloud.google.com")) {
    domainTags.push("gcp");
  }
  if (d.includes("azure.microsoft.com")) {
    domainTags.push("azure");
  }
  if (d.includes("kubernetes.io")) {
    domainTags.push("kubernetes");
  }
  if (d.includes("docker.com")) {
    domainTags.push("docker");
  }

  return domainTags;
}

function extractPatternTags(title: string): string[] {
  const patterns = [
    // Programming languages
    { pattern: /\b(?:rust|rustlang)\b/iu, tag: "rust" },
    { pattern: /\b(?:py|python)\b/iu, tag: "python" },
    { pattern: /\b(?:javascript|js)\b/iu, tag: "javascript" },
    { pattern: /\b(?:ts|typescript)\b/iu, tag: "typescript" },
    { pattern: /\b(?:go|golang)\b/iu, tag: "go" },
    { pattern: /\bjava\b/iu, tag: "java" },
    { pattern: /\b(?:c\+\+|cpp)\b/iu, tag: "cpp" },
    { pattern: /\b(?:c#|csharp)\b/iu, tag: "csharp" },
    { pattern: /\bphp\b/iu, tag: "php" },
    { pattern: /\bruby\b/iu, tag: "ruby" },
    { pattern: /\bswift\b/iu, tag: "swift" },
    { pattern: /\bkotlin\b/iu, tag: "kotlin" },
    { pattern: /\bscala\b/iu, tag: "scala" },
    { pattern: /\bhaskell\b/iu, tag: "haskell" },
    { pattern: /\bclojure\b/iu, tag: "clojure" },
    { pattern: /\belixir\b/iu, tag: "elixir" },
    { pattern: /\berlang\b/iu, tag: "erlang" },
    { pattern: /\bdart\b/iu, tag: "dart" },
    { pattern: /\bzig\b/iu, tag: "zig" },
    { pattern: /\bnim\b/iu, tag: "nim" },
    { pattern: /\bjulia\b/iu, tag: "julia" },
    { pattern: /\br\b/iu, tag: "r" },
    { pattern: /\bmatlab\b/iu, tag: "matlab" },
    { pattern: /\blua\b/iu, tag: "lua" },
    { pattern: /\bperl\b/iu, tag: "perl" },
    { pattern: /\b(?:bash|shell)\b/iu, tag: "bash" },

    // Frameworks and libraries
    { pattern: /\b(?:react|reactjs)\b/iu, tag: "reactjs" },
    { pattern: /\b(?:vue|vuejs)\b/iu, tag: "vuejs" },
    { pattern: /\bangular\b/iu, tag: "angular" },
    { pattern: /\bsvelte\b/iu, tag: "svelte" },
    { pattern: /\bnext\.?js\b/iu, tag: "nextjs" },
    { pattern: /\bnuxt\b/iu, tag: "nuxt" },
    { pattern: /\bexpress\b/iu, tag: "express" },
    { pattern: /\bfastapi\b/iu, tag: "fastapi" },
    { pattern: /\bflask\b/iu, tag: "flask" },
    { pattern: /\bdjango\b/iu, tag: "django" },
    { pattern: /\brails\b/iu, tag: "rails" },
    { pattern: /\blaravel\b/iu, tag: "laravel" },
    { pattern: /\bspring\b/iu, tag: "spring" },
    { pattern: /\b(?:tensorflow|tf)\b/iu, tag: "tensorflow" },
    { pattern: /\bpytorch\b/iu, tag: "pytorch" },
    { pattern: /\bkeras\b/iu, tag: "keras" },
    { pattern: /\bpandas\b/iu, tag: "pandas" },
    { pattern: /\bnumpy\b/iu, tag: "numpy" },
    { pattern: /\b(?:scikit-learn|sklearn)\b/iu, tag: "scikit-learn" },
    { pattern: /\bjquery\b/iu, tag: "jquery" },
    { pattern: /\bbootstrap\b/iu, tag: "bootstrap" },
    { pattern: /\btailwind\b/iu, tag: "tailwindcss" },

    // Databases
    { pattern: /\b(?:postgres|postgresql|psql)\b/iu, tag: "postgresql" },
    { pattern: /\bmysql\b/iu, tag: "mysql" },
    { pattern: /\b(?:mongo|mongodb)\b/iu, tag: "mongodb" },
    { pattern: /\bredis\b/iu, tag: "redis" },
    { pattern: /\bsqlite\b/iu, tag: "sqlite" },
    { pattern: /\bcassandra\b/iu, tag: "cassandra" },
    { pattern: /\b(?:elastic|elasticsearch)\b/iu, tag: "elasticsearch" },
    { pattern: /\binfluxdb\b/iu, tag: "influxdb" },
    { pattern: /\bclickhouse\b/iu, tag: "clickhouse" },
    { pattern: /\bdynamodb\b/iu, tag: "dynamodb" },

    // AI/ML/LLM patterns
    { pattern: /\b(?:gpt|chatgpt|gpt-\d)\b/iu, tag: "llm" },
    { pattern: /\b(?:llm|llms|large language model)s?\b/iu, tag: "llm" },
    { pattern: /\b(?:transformer|transformers)\b/iu, tag: "llm" },
    { pattern: /\b(?:bert|roberta|t5)\b/iu, tag: "llm" },
    { pattern: /\b(?:machine learning|ml)\b/iu, tag: "machine-learning" },
    { pattern: /\b(?:ai|artificial intelligence)\b/iu, tag: "llm" },
    { pattern: /\b(?:neural network|nn)\b/iu, tag: "neural-networks" },
    { pattern: /\b(?:deep learning|dl)\b/iu, tag: "deep-learning" },
    { pattern: /\b(?:computer vision|cv)\b/iu, tag: "computer-vision" },
    { pattern: /\b(?:natural language processing|nlp)\b/iu, tag: "nlp" },
    { pattern: /\b(?:reinforcement learning|rl)\b/iu, tag: "reinforcement-learning" },
    { pattern: /\b(?:genai|generative ai)\b/iu, tag: "generative-ai" },

    // Cloud and infrastructure
    { pattern: /\b(?:k8s|kubernetes)\b/iu, tag: "kubernetes" },
    { pattern: /\bdocker\b/iu, tag: "docker" },
    { pattern: /\b(?:amazon web services|aws)\b/iu, tag: "aws" },
    { pattern: /\b(?:gcp|google cloud)\b/iu, tag: "gcp" },
    { pattern: /\b(?:azure|microsoft azure)\b/iu, tag: "azure" },
    { pattern: /\bterraform\b/iu, tag: "terraform" },
    { pattern: /\bansible\b/iu, tag: "ansible" },
    { pattern: /\bjenkins\b/iu, tag: "jenkins" },
    { pattern: /\bgithub actions\b/iu, tag: "github-actions" },
    { pattern: /\bgitlab ci\b/iu, tag: "gitlab-ci" },
    { pattern: /\bmicroservices\b/iu, tag: "microservices" },
    { pattern: /\bserverless\b/iu, tag: "serverless" },
    { pattern: /\bdevops\b/iu, tag: "devops" },
    { pattern: /\b(?:ci\/cd|continuous integration)\b/iu, tag: "ci-cd" },

    // Technologies and protocols
    { pattern: /\b(?:wasm|web assembly|webassembly)\b/iu, tag: "webassembly" },
    { pattern: /\bgraphql\b/iu, tag: "graphql" },
    { pattern: /\b(?:rest api|restful)\b/iu, tag: "rest-api" },
    { pattern: /\b(?:websocket|websockets)\b/iu, tag: "websockets" },
    { pattern: /\bgrpc\b/iu, tag: "grpc" },
    { pattern: /\bblockchain\b/iu, tag: "blockchain" },
    { pattern: /\b(?:crypto|cryptocurrency)\b/iu, tag: "cryptocurrency" },
    { pattern: /\bbitcoin\b/iu, tag: "bitcoin" },
    { pattern: /\bethereum\b/iu, tag: "ethereum" },
    { pattern: /\bweb3\b/iu, tag: "web3" },
    { pattern: /\b(?:nft|nfts)\b/iu, tag: "nft" },
    { pattern: /\bapi\b/iu, tag: "api" },
    { pattern: /\boauth\b/iu, tag: "oauth" },
    { pattern: /\b(?:json web token|jwt)\b/iu, tag: "jwt" },

    // Companies and organizations
    { pattern: /\b(?:open ai|openai)\b/iu, tag: "openai" },
    { pattern: /\banthropic\b/iu, tag: "anthropic" },
    { pattern: /\bgoogle\b/iu, tag: "google" },
    { pattern: /\bmicrosoft\b/iu, tag: "microsoft" },
    { pattern: /\bapple\b/iu, tag: "apple" },
    { pattern: /\b(?:facebook|meta)\b/iu, tag: "meta" },
    { pattern: /\bamazon\b/iu, tag: "amazon" },
    { pattern: /\bnetflix\b/iu, tag: "netflix" },
    { pattern: /\buber\b/iu, tag: "uber" },
    { pattern: /\btesla\b/iu, tag: "tesla" },
    { pattern: /\bspacex\b/iu, tag: "spacex" },
  ];

  const tags: string[] = [];
  for (const { pattern, tag } of patterns) {
    if (pattern.test(title)) {
      tags.push(tag);
    }
  }

  return tags;
}

export function heuristicTags(title: string, domain?: string): string[] {
  const domainTags = extractDomainTags(domain);
  const patternTags = extractPatternTags(title);

  // Combine and deduplicate
  const allTags = [...domainTags, ...patternTags];
  const uniqueTags = [...new Set(allTags)];

  // Limit results to prevent bloat
  return uniqueTags.slice(0, 12);
}
