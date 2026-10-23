import { z } from "zod";
import articles from "../../data/kb_articles.json" with { type: "json" };
import { defineTool } from "./tool.js";

type Article = (typeof articles)[number];

export const KbProduct = z.enum(["billing", "platform", "appearance"]);

const MAX_RESULTS = 3;
const SNIPPET_LENGTH = 500; // Articles are short; a real KB would return the best matching passage.

// Where a query term is found decides how much it counts.
const WEIGHTS = { title: 3, tags: 2, body: 1 } as const;

const STOP_WORDS = new Set([
  "a", "an", "and", "are", "can", "do", "does", "for", "how", "i", "in", "is", "it", "my",
  "of", "on", "or", "the", "to", "what", "why", "with", "you", "your",
]);

/** Lowercase words, split on anything that is not a letter or digit (Unicode aware). */
export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((word) => word.length > 1 && !STOP_WORDS.has(word));
}

/** Simple keyword scoring. Good enough for a handful of articles; swap for vector search at scale. */
export function scoreArticle(article: Article, queryTerms: string[]): number {
  const title = new Set(tokenize(article.title));
  const tags = new Set(article.tags.flatMap(tokenize));
  const body = new Set(tokenize(article.body));

  let score = 0;
  for (const term of new Set(queryTerms)) {
    if (title.has(term)) score += WEIGHTS.title;
    if (tags.has(term)) score += WEIGHTS.tags;
    if (body.has(term)) score += WEIGHTS.body;
  }
  return score;
}

function toSnippet(body: string): string {
  if (body.length <= SNIPPET_LENGTH) return body;
  return `${body.slice(0, body.lastIndexOf(" ", SNIPPET_LENGTH))}...`;
}

export const knowledgeBaseTool = defineTool({
  name: "search_knowledge_base",
  description:
    "Search help center articles (FAQ and docs) by keywords. Returns up to 3 matches with id, title, url and snippet. " +
    "Use English keywords even if the ticket is in another language.",
  args: z.object({
    query: z.string().min(1).describe('English keywords, e.g. "dark mode system default"'),
    product: KbProduct.optional().describe(
      "Prefer articles for this product area. If none match, all articles are searched.",
    ),
  }),
  async handler({ query, product }) {
    const inProduct = product ? search(query, articles.filter((a) => a.product === product)) : [];
    // A wrong product guess should not hide a relevant article, so fall back to the whole KB.
    return inProduct.length > 0 ? inProduct : search(query, articles);
  },
});

/** Best matches first; articles that match no query term are left out. */
function search(query: string, candidates: readonly Article[]) {
  const terms = tokenize(query);
  return candidates
    .map((article) => ({ article, score: scoreArticle(article, terms) }))
    .filter(({ score }) => score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, MAX_RESULTS)
    .map(({ article, score }) => ({
      id: article.id,
      title: article.title,
      url: article.url,
      snippet: toSnippet(article.body),
      score,
    }));
}
