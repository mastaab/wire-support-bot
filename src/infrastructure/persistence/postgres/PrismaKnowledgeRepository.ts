import type {
  KnowledgeDocumentRecord, KnowledgeRepository, KnowledgeVersion, NewKnowledgeDocument, StoredKnowledgeChunk,
} from "../../../domain/repositories/KnowledgeRepository";
import { getPrismaClient } from "./PrismaClient";
import { decodeEmbedding, encodeEmbedding } from "./embeddingBytes";

const documentFields = {
  id: true, sourcePath: true, title: true, contentHash: true, embeddingModel: true, ingestedAt: true,
} as const;

/** The document index in the knowledge_documents and knowledge_chunks tables; embeddings as little-endian float32 bytes. */
export class PrismaKnowledgeRepository implements KnowledgeRepository {
  private prisma = getPrismaClient();

  async listDocuments(): Promise<KnowledgeDocumentRecord[]> {
    return this.prisma.knowledgeDocument.findMany({ select: documentFields, orderBy: { sourcePath: "asc" } });
  }

  async replaceDocument(document: NewKnowledgeDocument): Promise<KnowledgeDocumentRecord> {
    const { chunks, ...fields } = document;
    // The chunks of a replaced document go with it (ON DELETE CASCADE).
    return this.prisma.$transaction(async (tx) => {
      await tx.knowledgeDocument.deleteMany({ where: { sourcePath: fields.sourcePath } });
      const stored = await tx.knowledgeDocument.create({ data: fields, select: documentFields });
      if (chunks.length > 0) {
        await tx.knowledgeChunk.createMany({
          data: chunks.map((chunk) => ({
            documentId: stored.id,
            position: chunk.position,
            headingPath: chunk.headingPath,
            content: chunk.content,
            embedding: encodeEmbedding(chunk.embedding),
            dimension: chunk.embedding.length,
          })),
        });
      }
      return stored;
    }, { timeout: 30_000 });
  }

  async deleteDocuments(sourcePaths: readonly string[]): Promise<number> {
    if (sourcePaths.length === 0) return 0;
    const { count } = await this.prisma.knowledgeDocument.deleteMany({ where: { sourcePath: { in: [...sourcePaths] } } });
    return count;
  }

  async version(): Promise<KnowledgeVersion> {
    const [documents, chunks] = await Promise.all([
      this.prisma.knowledgeDocument.aggregate({ _count: { _all: true }, _max: { ingestedAt: true } }),
      this.prisma.knowledgeChunk.count(),
    ]);
    return { documents: documents._count._all, chunks, latestIngestedAt: documents._max.ingestedAt };
  }

  async loadChunks(embeddingModel: string): Promise<{ chunks: StoredKnowledgeChunk[]; otherModelChunks: number }> {
    const [rows, otherModelChunks] = await Promise.all([
      this.prisma.knowledgeChunk.findMany({
        where: { document: { embeddingModel } },
        select: {
          documentId: true, position: true, headingPath: true, content: true, embedding: true, dimension: true,
          document: { select: { title: true, ingestedAt: true } },
        },
        orderBy: [{ documentId: "asc" }, { position: "asc" }],
      }),
      this.prisma.knowledgeChunk.count({ where: { document: { embeddingModel: { not: embeddingModel } } } }),
    ]);
    return {
      chunks: rows.map((row) => ({
        documentId: row.documentId,
        title: row.document.title,
        position: row.position,
        headingPath: row.headingPath,
        content: row.content,
        embedding: decodeEmbedding(row.embedding, row.dimension),
        ingestedAt: row.document.ingestedAt,
      })),
      otherModelChunks,
    };
  }
}
