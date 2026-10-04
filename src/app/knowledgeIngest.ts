/**
 * Knowledge ingestion: brings the document index in line with a directory of Markdown and plain
 * text documents (see `IngestKnowledge`), embedding new and changed documents with
 * WIRE_SUPPORT_BOT_EMBED_MODEL.
 *
 * Usage:
 *   npm run knowledge:ingest -- <directory>
 *   node dist/app/knowledgeIngest.js <directory>      (in the container, for example with kubectl exec)
 *
 * Reads `.env` from the working directory like the bot; settings already in the environment take
 * precedence. Needs the database (DATABASE_URL, or the DATABASE_* parts as in the container) and
 * the embeddings endpoint, not Wire or Jira. Prints a short summary and no document content, and
 * exits with code 1 on an error. The bot picks up the change within a minute, without a restart.
 */

import dotenv from "dotenv";
import { resolveKnowledgeConfig } from "./config";
import { resolveDatabaseUrl } from "./databaseUrl";
import { initLogging, writeSafely } from "./logging";
import { readKnowledgeDirectory } from "./knowledgeFiles";
import { IngestKnowledge, KnowledgeIngestError } from "../application/usecases/knowledge/IngestKnowledge";
import { EmbeddingError } from "../application/ports/EmbeddingPort";
import { OpenAIEmbeddingAdapter } from "../infrastructure/llm/OpenAIEmbeddingAdapter";
import { PrismaKnowledgeRepository } from "../infrastructure/persistence/postgres/PrismaKnowledgeRepository";
import { getPrismaClient } from "../infrastructure/persistence/postgres/PrismaClient";

dotenv.config();

const USAGE = "Usage: npm run knowledge:ingest -- <directory>\n";

async function main(): Promise<number> {
  const directory = process.argv[2];
  if (!directory || process.argv.length > 3 || directory.startsWith("-")) {
    writeSafely(process.stderr, USAGE);
    return 2;
  }
  let knowledge;
  try {
    knowledge = resolveKnowledgeConfig(process.env, { requireEmbedding: true });
    // In the container the URL may come as parts (DATABASE_HOST, ...), which only the entry point joins.
    process.env.DATABASE_URL = resolveDatabaseUrl(process.env);
  } catch (error) {
    // Configuration messages name the setting, never a secret value.
    writeSafely(process.stderr, `Invalid configuration: ${error instanceof Error ? error.message : "unknown error"}\n`);
    return 1;
  }
  initLogging(process.env.LOG_LEVEL ?? "warn", { stream: "stderr" });

  try {
    const files = await readKnowledgeDirectory(directory);
    const embeddings = new OpenAIEmbeddingAdapter(knowledge.embedding);
    const summary = await new IngestKnowledge(new PrismaKnowledgeRepository(), embeddings).execute(files);
    writeSafely(process.stdout,
      `Knowledge ingestion (${embeddings.model}): ${summary.added} added, ${summary.updated} updated, ${summary.unchanged} unchanged, `
      + `${summary.removed} removed; ${summary.chunksTotal} chunks (${summary.chunksWritten} embedded)\n`);
    if (!knowledge.enabled) writeSafely(process.stdout, "Note: WIRE_SUPPORT_BOT_KNOWLEDGE is off, so the bot does not use the index yet.\n");
    return 0;
  } catch (error) {
    writeSafely(process.stderr, `Knowledge ingestion failed: ${describe(error)}\n`);
    return 1;
  } finally {
    await getPrismaClient().$disconnect().catch(() => undefined);
  }
}

/** Our own errors carry safe messages (a reason, a status, a file path); anything else only its class name. */
function describe(error: unknown): string {
  if (error instanceof EmbeddingError) return `${error.message}; check WIRE_SUPPORT_BOT_EMBED_BASE_URL and WIRE_SUPPORT_BOT_EMBED_MODEL`;
  if (error instanceof KnowledgeIngestError) return error.message;
  if (error instanceof Error && /^(Not a directory|Document larger than)/.test(error.message)) return error.message;
  const name = error instanceof Error ? error.constructor.name || error.name : "UnknownError";
  const code = (error as { code?: unknown } | null)?.code;
  // Node's file system errors have codes such as ENOENT or EACCES, Prisma's such as P1001.
  if (typeof code === "string" && /^E[A-Z]+$/.test(code)) return `${name} ${code} while reading the documents`;
  const prismaCode = typeof code === "string" && /^P\d{4}$/.test(code) ? ` ${code}` : "";
  return `${name}${prismaCode}; check the database settings and that the migrations are applied`;
}

main().then((code) => process.exit(code), () => process.exit(1));
